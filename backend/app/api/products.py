import os
import uuid
import threading
import hashlib
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
from app.database import get_db
from app.models.user import User
from app.models.product import Product
from app.models.scan_job import ScanJob
from app.schemas.product import ProductResponse, ProductHistoryResponse, ProductHistoryItem
from app.schemas.scan import ScanJobStatusResponse, ScanJobResultResponse, ScanJobEditFieldRequest
from app.core.dependencies import get_current_user, require_inspector_or_admin
from app.storage.minio_client import storage_service
from app.tasks.celery_app import is_celery_available
from app.tasks.scan_worker import process_scan_task, execute_scan_pipeline

router = APIRouter(prefix="/products", tags=["Products & Scanning"])

@router.post("/scan")
async def create_scan_job(
    images: Optional[List[UploadFile]] = File(None),
    image: Optional[UploadFile] = File(None),
    back_image: Optional[UploadFile] = File(None),
    reference_scale_mm: Optional[float] = Form(None),
    product_name: Optional[str] = Form(None),
    category: Optional[str] = Form("Packaged Food"),
    inspector_notes: Optional[str] = Form(None),
    qr_evidence: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_inspector_or_admin)
):
    # Collect all uploaded images (supporting multiple panel files)
    all_files: List[UploadFile] = []
    valid_images = [f for f in (images or []) if f and f.filename]
    if valid_images:
        all_files.extend(valid_images)
    else:
        if image and image.filename:
            all_files.append(image)
        if back_image and back_image.filename:
            all_files.append(back_image)

    if not all_files:
        raise HTTPException(status_code=400, detail="At least one image panel must be uploaded")

    uploaded_urls: List[str] = []
    uploaded_filenames: List[str] = []
    images_bytes_list: List[bytes] = []
    seen_hashes = set()

    for idx, f in enumerate(all_files):
        f_bytes = await f.read()
        if len(f_bytes) == 0:
            continue
        byte_hash = hashlib.sha256(f_bytes).hexdigest()
        if byte_hash in seen_hashes:
            continue
        seen_hashes.add(byte_hash)
        images_bytes_list.append(f_bytes)
        file_ext = f.filename.split(".")[-1] if "." in f.filename else "jpg"
        unique_fn = f"scan_{uuid.uuid4().hex[:12]}_p{len(images_bytes_list)}.{file_ext}"
        u_url = storage_service.upload_file(f_bytes, unique_fn, f.content_type or "image/jpeg")
        uploaded_urls.append(u_url)
        uploaded_filenames.append(unique_fn)

    if not uploaded_urls:
        raise HTTPException(status_code=400, detail="Uploaded file(s) were empty")

    # Optional QR evidence file
    qr_evidence_fn: Optional[str] = None
    qr_evidence_path: Optional[str] = None
    if qr_evidence and qr_evidence.filename:
        q_bytes = await qr_evidence.read()
        if q_bytes:
            q_ext = qr_evidence.filename.split(".")[-1] if "." in qr_evidence.filename else "jpg"
            qr_evidence_fn = f"qr_{uuid.uuid4().hex[:12]}.{q_ext}"
            storage_service.upload_file(q_bytes, qr_evidence_fn, qr_evidence.content_type or "image/jpeg")
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=f".{q_ext}", delete=False) as qtf:
                qtf.write(q_bytes)
                qr_evidence_path = qtf.name

    # Associate or create product
    name = product_name.strip() if product_name and product_name.strip() else f"Product Sample #{uuid.uuid4().hex[:6]}"
    product = Product(
        product_name=name,
        category=category or "Packaged Food",
        latest_compliance_status="PENDING",
        inspection_count=1
    )
    db.add(product)
    db.flush()

    # Create ScanJob
    job_id = str(uuid.uuid4())
    scan_job = ScanJob(
        id=job_id,
        product_id=product.id,
        inspector_id=current_user.id,
        image_url=uploaded_urls[0],
        image_urls=uploaded_urls,
        back_image_url=uploaded_urls[1] if len(uploaded_urls) > 1 else None,
        reference_scale_mm=reference_scale_mm,
        status="PENDING",
        progress_percentage=5,
        current_stage_message=f"Job queued with {len(uploaded_urls)} panel image(s)",
        inspector_notes=inspector_notes
    )
    db.add(scan_job)
    db.commit()
    db.refresh(scan_job)

    # Dispatch to Celery if active, otherwise background thread
    dispatched_celery = False
    if is_celery_available():
        try:
            process_scan_task.delay(job_id, uploaded_filenames, reference_scale_mm, qr_evidence_fn)
            dispatched_celery = True
        except Exception:
            dispatched_celery = False

    if not dispatched_celery:
        t = threading.Thread(
            target=execute_scan_pipeline,
            args=(job_id, images_bytes_list, reference_scale_mm, uploaded_urls, qr_evidence_path),
            daemon=True
        )
        t.start()

    return {
        "job_id": job_id,
        "product_id": product.id,
        "panels_count": len(uploaded_urls),
        "status": "PENDING",
        "message": f"Scan job successfully queued with {len(uploaded_urls)} panel image(s).",
        "async_broker": "celery" if dispatched_celery else "background_thread"
    }

@router.post("/scan/{job_id}/qr-evidence")
async def submit_qr_evidence(
    job_id: str,
    qr_screenshot: UploadFile = File(...),
    batch_code: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_inspector_or_admin)
):
    """
    Submits inspector-captured screenshot evidence of the manufacturer portal
    to resolve attended Rule 6(1)(a) verification for packaging with QR mandates.
    Accepts optional inspector-edited batch code.
    """
    job = db.query(ScanJob).filter(ScanJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail=f"Scan job {job_id} not found")

    screenshot_bytes = await qr_screenshot.read()
    if not screenshot_bytes:
        raise HTTPException(status_code=400, detail="Uploaded QR portal screenshot is empty")

    ext = qr_screenshot.filename.split(".")[-1] if "." in qr_screenshot.filename else "jpg"
    evidence_fn = f"qr_evidence_{job_id[:8]}_{uuid.uuid4().hex[:6]}.{ext}"
    evidence_url = storage_service.upload_file(
        screenshot_bytes, evidence_fn, qr_screenshot.content_type or "image/jpeg"
    )

    job.status = "PROCESSING"
    job.progress_percentage = 50
    job.current_stage_message = "Analyzing manufacturer portal evidence and completing audit..."
    job.qr_evidence_url = evidence_url
    if batch_code and batch_code.strip():
        job.code_to_enter = batch_code.strip()
    db.commit()

    image_filenames = [os.path.basename(u) for u in (job.image_urls or [job.image_url])]
    dispatched_celery = False
    if is_celery_available():
        try:
            process_scan_task.delay(job_id, image_filenames, job.reference_scale_mm, evidence_fn, False, False, batch_code)
            dispatched_celery = True
        except Exception:
            dispatched_celery = False
    if not dispatched_celery:
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as tf:
            tf.write(screenshot_bytes)
            tf_name = tf.name

        img_bytes_list = []
        for fn in image_filenames:
            f_data = storage_service.get_file(fn)
            if f_data:
                img_bytes_list.append(f_data[0])

        t = threading.Thread(
            target=execute_scan_pipeline,
            args=(job_id, img_bytes_list, job.reference_scale_mm, job.image_urls, tf_name, False, False, batch_code),
            daemon=True
        )
        t.start()

    return {
        "job_id": job.id,
        "status": "PROCESSING",
        "message": "QR portal evidence uploaded successfully. Compliance evaluation resumed.",
        "qr_evidence_url": evidence_url,
        "batch_code_used": job.code_to_enter,
        "async_broker": "celery" if dispatched_celery else "background_thread"
    }

@router.post("/scan/{job_id}/no-batch-code")
def submit_no_batch_code(
    job_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_inspector_or_admin)
):
    """
    Resolves QR verification when packaging directs to a QR portal but no batch code
    is present on the packaging to enter. Flags manufacturer details as NEEDS_MANUAL_INSPECTION
    with resolution_method: NO_BATCH_CODE_ON_PACKAGE.
    """
    job = db.query(ScanJob).filter(ScanJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail=f"Scan job {job_id} not found")

    job.status = "PROCESSING"
    job.progress_percentage = 50
    job.current_stage_message = "No batch code present on package; flagging for physical manual inspection..."
    db.commit()

    image_filenames = [os.path.basename(u) for u in (job.image_urls or [job.image_url])]
    dispatched_celery = False
    if is_celery_available():
        try:
            process_scan_task.delay(job_id, image_filenames, job.reference_scale_mm, None, False, True, None)
            dispatched_celery = True
        except Exception:
            dispatched_celery = False
    if not dispatched_celery:
        img_bytes_list = []
        for fn in image_filenames:
            f_data = storage_service.get_file(fn)
            if f_data:
                img_bytes_list.append(f_data[0])

        t = threading.Thread(
            target=execute_scan_pipeline,
            args=(job_id, img_bytes_list, job.reference_scale_mm, job.image_urls, None, False, True, None),
            daemon=True
        )
        t.start()

    return {
        "job_id": job.id,
        "status": "PROCESSING",
        "message": "Recorded no batch code on packaging. Compliance evaluation resumed with manual inspection flag.",
        "async_broker": "celery" if dispatched_celery else "background_thread"
    }

@router.post("/scan/{job_id}/skip-qr-evidence")
def skip_qr_evidence(
    job_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_inspector_or_admin)
):
    """
    Skips QR portal verification when inspector chooses not to provide screenshot evidence.
    Flags manufacturer details as NEEDS_MANUAL_INSPECTION without halting the pipeline.
    """
    job = db.query(ScanJob).filter(ScanJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail=f"Scan job {job_id} not found")

    job.status = "PROCESSING"
    job.progress_percentage = 50
    job.current_stage_message = "Skipping QR portal verification; flagging for physical manual inspection..."
    db.commit()

    image_filenames = [os.path.basename(u) for u in (job.image_urls or [job.image_url])]
    dispatched_celery = False
    if is_celery_available():
        try:
            process_scan_task.delay(job_id, image_filenames, job.reference_scale_mm, None, True, False, None)
            dispatched_celery = True
        except Exception:
            dispatched_celery = False
    if not dispatched_celery:
        img_bytes_list = []
        for fn in image_filenames:
            f_data = storage_service.get_file(fn)
            if f_data:
                img_bytes_list.append(f_data[0])

        t = threading.Thread(
            target=execute_scan_pipeline,
            args=(job_id, img_bytes_list, job.reference_scale_mm, job.image_urls, None, True, False, None),
            daemon=True
        )
        t.start()

    return {
        "job_id": job.id,
        "status": "PROCESSING",
        "message": "QR portal verification skipped. Compliance evaluation resumed with manual inspection flag.",
        "async_broker": "celery" if dispatched_celery else "background_thread"
    }

@router.get("/scan/{job_id}/status", response_model=ScanJobStatusResponse)
def get_scan_status(job_id: str, db: Session = Depends(get_db)):
    job = db.query(ScanJob).filter(ScanJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail=f"Scan job {job_id} not found")

    # Step 6 Timeout Auto-Resolution:
    # If AWAITING_QR_EVIDENCE has sat unresolved for more than 10 minutes (600s), auto-resolve via skip
    if job.status == "AWAITING_QR_EVIDENCE" and job.awaiting_qr_since:
        from datetime import datetime
        elapsed = (datetime.utcnow() - job.awaiting_qr_since).total_seconds()
        if elapsed > 600:
            import logging
            logging.getLogger(__name__).info(f"Scan job {job_id} QR evidence timed out ({elapsed:.1f}s). Auto-resuming with manual inspection flag.")
            job.status = "PROCESSING"
            job.progress_percentage = 50
            job.current_stage_message = "QR portal verification timed out; flagged for manual inspection..."
            db.commit()

            image_filenames = [os.path.basename(u) for u in (job.image_urls or [job.image_url])]
            try:
                process_scan_task.delay(job_id, image_filenames, job.reference_scale_mm, None, True, False, None)
            except Exception:
                pass

    extracted_data = job.extracted_data or {}
    available_compliance_qrs = extracted_data.get("available_compliance_qrs")
    batch_code_confidence = extracted_data.get("batch_code_confidence")
    batch_code_flag = extracted_data.get("batch_code_flag")

    return ScanJobStatusResponse(
        id=job.id,
        status=job.status,
        progress_percentage=job.progress_percentage,
        current_stage_message=job.current_stage_message,
        created_at=job.created_at,
        completed_at=job.completed_at,
        detected_qr_url=job.detected_qr_url,
        code_to_enter=job.code_to_enter,
        awaiting_qr_since=job.awaiting_qr_since,
        available_compliance_qrs=available_compliance_qrs,
        batch_code_confidence=batch_code_confidence,
        batch_code_flag=batch_code_flag
    )

@router.get("/scan/{job_id}/result", response_model=ScanJobResultResponse)
def get_scan_result(job_id: str, db: Session = Depends(get_db)):
    job = db.query(ScanJob).filter(ScanJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail=f"Scan job {job_id} not found")
    
    product_name = job.product.product_name if job.product else "Packaged Commodity"
    brand_name = job.product.brand_name if job.product else None
    category = job.product.category if job.product else "Packaged Commodity"
    inspector_name = job.inspector.full_name if job.inspector else "Legal Metrology Inspector"
    
    panel_urls = job.image_urls or ([job.image_url] if job.image_url else [])

    return ScanJobResultResponse(
        id=job.id,
        product_id=job.product_id,
        product_name=product_name,
        brand_name=brand_name,
        category=category,
        inspector_id=job.inspector_id,
        inspector_name=inspector_name,
        image_url=job.image_url,
        image_urls=panel_urls,
        back_image_url=job.back_image_url,
        reference_scale_mm=job.reference_scale_mm,
        status=job.status,
        progress_percentage=job.progress_percentage,
        current_stage_message=job.current_stage_message,
        overall_compliance_verdict=job.overall_compliance_verdict or "PENDING",
        compliance_score=job.compliance_score or 0.0,
        extracted_data=job.extracted_data or {},
        rule_results=job.rule_results or [],
        raw_ocr_tokens=job.raw_ocr_tokens or [],
        clustered_blocks=job.clustered_blocks or [],
        cross_referenced_fields=job.cross_referenced_fields or [],
        pdf_report_url=job.pdf_report_url,
        docx_report_url=job.docx_report_url,
        inspector_notes=job.inspector_notes,
        edited_fields=job.edited_fields or {},
        detected_qr_url=job.detected_qr_url,
        code_to_enter=job.code_to_enter,
        qr_evidence_url=job.qr_evidence_url,
        available_compliance_qrs=(job.extracted_data or {}).get("available_compliance_qrs"),
        created_at=job.created_at,
        completed_at=job.completed_at
    )

@router.patch("/scan/{job_id}/edit-field", response_model=ScanJobResultResponse)
def edit_scan_field(
    job_id: str,
    payload: ScanJobEditFieldRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_inspector_or_admin)
):
    """
    Human-in-the-Loop inspection update:
    Allows an inspector or admin to manually verify and edit AI-extracted information.
    Updates the master report, synchronizes repository product details, flags the field
    with manual edit metadata for an amber badge, and invalidates/refreshes stored reports.
    """
    job = db.query(ScanJob).filter(ScanJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail=f"Scan job {job_id} not found")

    import copy
    from datetime import datetime
    field_key = payload.field_key.strip()
    new_val = payload.new_value.strip()

    extracted = copy.deepcopy(job.extracted_data or {})
    master_report = extracted.get("master_report") or {}
    mand = master_report.get("mandatory_declarations") or {}
    mfg = master_report.get("manufacturer_details") or {}
    edited = copy.deepcopy(job.edited_fields or {})

    # Field mapping dictionary
    # Maps field_key to (extracted_data key, mandatory_declarations key, rule_id, default_label)
    FIELD_MAP = {
        "product_name": ("product_name", None, "RULE_6_1_B", "Product / Brand Name"),
        "generic_name": ("generic_name", "generic_commodity_name", "RULE_6_1_B", "Common / Generic Commodity Name"),
        "manufacturer_name": ("manufacturer_name", "manufacturer_name", "RULE_6_1_A", "Manufacturer Legal Name"),
        "manufacturer_address": ("manufacturer_address", "manufacturer_address", "RULE_6_1_A", "Manufacturer Address"),
        "net_quantity": ("net_quantity", "net_quantity", "RULE_6_1_C_AND_13", "Net Quantity"),
        "mrp": ("mrp", "mrp", "RULE_6_1_E", "Maximum Retail Price (MRP)"),
        "unit_sale_price": ("unit_sale_price", "unit_sale_price", "RULE_6_1_E_USP", "Unit Sale Price (USP)"),
        "mfg_date": ("mfg_date", "mfg_or_pkd_date", "RULE_6_1_D", "Date of Manufacture"),
        "consumer_care": ("consumer_care", "consumer_care_details", "RULE_6_1_F", "Consumer Care"),
        "country_of_origin": ("country_of_origin", "country_of_origin", "RULE_6_1_G", "Country of Origin"),
        "font_size": ("font_size", None, "RULE_7_FONT_SIZE", "Numeral & Letter Height (Rule 7(2))"),
        "color_contrast": ("color_contrast", None, "RULE_9_CONTRAST", "Background Color Contrast (Rule 9(1)(b))"),
    }

    mapping = FIELD_MAP.get(field_key, (field_key, field_key, None, field_key.replace('_', ' ').title()))
    ext_key, mand_key, rule_id, def_label = mapping

    orig_record = edited.get(field_key)

    if payload.revert:
        # Revert back to original AI value and AI status/remarks if stored
        if orig_record:
            orig = orig_record.get("original_value")
            orig_status = orig_record.get("original_status")
            orig_remarks = orig_record.get("original_remarks")
            edited.pop(field_key, None)
            if orig is not None:
                new_val = str(orig)
            if orig_status is not None:
                payload.status = orig_status
        else:
            edited.pop(field_key, None)
    else:
        # Capture original AI value and original status if not already recorded
        curr_val = (
            extracted.get(ext_key, {}).get("value")
            or (mand.get(mand_key, {}).get("declared_value") if mand_key else None)
            or (mfg.get("resolved_manufacturer_name") if field_key == "manufacturer_name" else None)
            or (mfg.get("resolved_address") if field_key == "manufacturer_address" else None)
            or (job.product.product_name if field_key == "product_name" and job.product else None)
            or (
                (master_report.get("visual_and_metrology_audit", {}).get("rule_7_font_size", {}).get("measured_numeral_height_mm"))
                if field_key == "font_size" and master_report.get("visual_and_metrology_audit", {}).get("rule_7_font_size", {}).get("measured_numeral_height_mm") is not None
                else None
            )
            or (
                master_report.get("visual_and_metrology_audit", {}).get("rule_9_color_contrast", {}).get("contrast_ratio")
                if field_key == "color_contrast"
                else None
            )
            or ""
        )
        # Capture original status & remarks
        existing_rule = next((r for r in (job.rule_results or []) if r.get("rule_id") == rule_id or r.get("field_key") == field_key), None)
        curr_rule_status = existing_rule.get("status") if existing_rule else None
        curr_rule_remarks = existing_rule.get("remarks") if existing_rule else None

        orig_val = orig_record.get("original_value", curr_val) if orig_record else curr_val
        orig_st = orig_record.get("original_status", curr_rule_status) if orig_record else curr_rule_status
        orig_rem = orig_record.get("original_remarks", curr_rule_remarks) if orig_record else curr_rule_remarks

        edited_entry = {
            "original_value": orig_val,
            "original_status": orig_st,
            "original_remarks": orig_rem,
            "edited_value": new_val,
            "edited_by": current_user.full_name,
            "edited_by_role": current_user.role,
            "edited_at": datetime.utcnow().isoformat()
        }
        if payload.status:
            edited_entry["status_override"] = payload.status
        edited[field_key] = edited_entry

    # Ensure new_val is always a string to avoid AttributeError on .lower()
    new_val_str = str(new_val) if new_val is not None else ""

    # Determine status based on explicit override or presence of valid value
    is_explicit_compliant = None
    if payload.status:
        st_clean = str(payload.status).strip().upper()
        if st_clean in ["COMPLIANT", "PASS", "VALID"]:
            is_explicit_compliant = True
        elif st_clean in ["NON_COMPLIANT", "NON-COMPLIANT", "FAIL", "INVALID", "MISSING"]:
            is_explicit_compliant = False

    is_compliant_final = is_explicit_compliant if is_explicit_compliant is not None else (
        True if new_val_str and new_val_str.lower() not in ["not declared on pack", "not found", ""] else False
    )
    status_label_text = "COMPLIANT" if is_compliant_final else "NON-COMPLIANT"

    is_manually_edited = (field_key in edited)

    # 1. Update extracted_data top-level key and ext_key
    status_str = "found" if is_compliant_final else "missing"
    target_keys = set(filter(None, [ext_key, field_key]))
    for k in target_keys:
        if k not in extracted or not isinstance(extracted[k], dict):
            extracted[k] = {"label": def_label, "confidence": 1.0}
        extracted[k]["value"] = new_val
        extracted[k]["status"] = status_str
        if is_manually_edited:
            extracted[k]["validation_remarks"] = f"Manually verified as {status_label_text} by inspector {current_user.full_name} under PCR 2011."
            extracted[k]["confidence"] = 1.0
        elif orig_record and orig_record.get("original_remarks"):
            extracted[k]["validation_remarks"] = orig_record.get("original_remarks")
        extracted[k]["is_manually_edited"] = is_manually_edited

    # 2. Update master_report and sub-structures
    if field_key == "product_name":
        master_report["product_name"] = new_val
        if job.product:
            job.product.product_name = new_val
    elif field_key == "manufacturer_name":
        mfg["resolved_manufacturer_name"] = new_val
        mfg["compliance_status"] = status_str
        mfg["is_compliant"] = is_compliant_final
        if is_manually_edited:
            mfg["compliance_remarks"] = f"Manufacturer name verified as {status_label_text} by inspector {current_user.full_name}."
        master_report["manufacturer_details"] = mfg
        if job.product:
            job.product.manufacturer_name = new_val
    elif field_key == "manufacturer_address":
        mfg["resolved_address"] = new_val
        mfg["compliance_status"] = status_str
        mfg["is_compliant"] = is_compliant_final
        if is_manually_edited:
            mfg["compliance_remarks"] = f"Premises address verified as {status_label_text} by inspector {current_user.full_name}."
        master_report["manufacturer_details"] = mfg
    elif mand_key:
        if mand_key not in mand:
            mand[mand_key] = {}
        mand[mand_key]["declared_value"] = new_val
        mand[mand_key]["compliance_status"] = status_str
        mand[mand_key]["is_compliant"] = is_compliant_final
        if is_manually_edited:
            mand[mand_key]["compliance_remarks"] = f"Declaration verified as {status_label_text} by inspector {current_user.full_name}."
        master_report["mandatory_declarations"] = mand

    # Special handling for USP in master_report
    if field_key == "unit_sale_price":
        if "unit_sale_price" not in mand:
            mand["unit_sale_price"] = {}
        mand["unit_sale_price"]["declared_value"] = new_val
        mand["unit_sale_price"]["compliance_status"] = status_str
        mand["unit_sale_price"]["is_compliant"] = is_compliant_final
        if is_manually_edited:
            mand["unit_sale_price"]["compliance_remarks"] = f"Unit Sale Price verified as {status_label_text} by inspector {current_user.full_name}."
        master_report["mandatory_declarations"] = mand
        if "usp_cross_verification" in master_report and isinstance(master_report["usp_cross_verification"], dict):
            master_report["usp_cross_verification"]["is_compliant"] = is_compliant_final
            master_report["usp_cross_verification"]["declared_usp_raw"] = new_val
            if is_manually_edited:
                master_report["usp_cross_verification"]["remarks"] = f"Unit Sale Price verified as {status_label_text} by inspector {current_user.full_name}."

    # Special handling for Visual & Metrology Audit in master_report
    if "visual_and_metrology_audit" not in master_report or not isinstance(master_report["visual_and_metrology_audit"], dict):
        master_report["visual_and_metrology_audit"] = copy.deepcopy(extracted.get("visual_and_metrology_audit") or {})
    vis_metro = master_report["visual_and_metrology_audit"]

    if field_key == "font_size":
        if "rule_7_font_size" not in vis_metro or not isinstance(vis_metro["rule_7_font_size"], dict):
            vis_metro["rule_7_font_size"] = {}
        font_sub = vis_metro["rule_7_font_size"]
        font_sub["is_compliant"] = is_compliant_final
        font_sub["status"] = "COMPLIANT" if is_compliant_final else "FAIL"
        # Parse numeric mm if available, or keep string
        clean_num = new_val_str.replace("mm", "").replace("Min:", "").strip()
        try:
            font_sub["measured_numeral_height_mm"] = float(clean_num.split()[0])
        except Exception:
            font_sub["measured_numeral_height_mm"] = new_val
        if is_manually_edited:
            font_sub["remarks"] = f"Font height manually verified as {status_label_text} by inspector {current_user.full_name} under Table-I (Rule 7(2))."
        elif orig_record and orig_record.get("original_remarks"):
            font_sub["remarks"] = orig_record.get("original_remarks")
        master_report["visual_and_metrology_audit"] = vis_metro
        extracted["visual_and_metrology_audit"] = vis_metro

    elif field_key == "color_contrast":
        if "rule_9_color_contrast" not in vis_metro or not isinstance(vis_metro["rule_9_color_contrast"], dict):
            vis_metro["rule_9_color_contrast"] = {}
        cont_sub = vis_metro["rule_9_color_contrast"]
        cont_sub["is_compliant"] = is_compliant_final
        cont_sub["contrast_ratio"] = new_val
        if is_manually_edited:
            cont_sub["remarks"] = f"Color contrast manually verified as {status_label_text} by inspector {current_user.full_name} under Rule 9(1)(b)."
        elif orig_record and orig_record.get("original_remarks"):
            cont_sub["remarks"] = orig_record.get("original_remarks")
        master_report["visual_and_metrology_audit"] = vis_metro
        extracted["visual_and_metrology_audit"] = vis_metro

    # 3. Synchronize repository Product fields if net_quantity or mrp
    if field_key == "net_quantity" and job.product:
        job.product.declared_net_quantity = new_val
    if field_key == "mrp" and job.product:
        job.product.declared_mrp = new_val

    # 4. Synchronize rule_results
    rules = copy.deepcopy(job.rule_results or [])
    for r in rules:
        target_match = False
        if rule_id and r.get("rule_id") == rule_id:
            target_match = True
        elif r.get("field_key") == field_key or r.get("field_key") == ext_key:
            target_match = True
        elif field_key in ["manufacturer_name", "manufacturer_address"] and (r.get("rule_id") == "RULE_6_1_A" or r.get("field_key") in ["manufacturer_details", "manufacturer_name"]):
            target_match = True
        elif field_key == "net_quantity" and (r.get("rule_id") in ["RULE_6_1_C", "RULE_6_1_C_AND_13"] or r.get("field_key") == "net_quantity"):
            target_match = True
        elif field_key == "mrp" and (r.get("rule_id") == "RULE_6_1_E" or r.get("field_key") == "mrp"):
            target_match = True
        elif field_key == "unit_sale_price" and (r.get("rule_id") in ["RULE_6_1_E_USP", "RULE_6_1_E"] or r.get("field_key") == "unit_sale_price"):
            target_match = True
        elif field_key == "mfg_date" and (r.get("rule_id") in ["RULE_6_1_D", "RULE_6_1_D_MFG"] or r.get("field_key") == "mfg_date"):
            target_match = True
        elif field_key == "consumer_care" and (r.get("rule_id") == "RULE_6_1_F" or r.get("field_key") == "consumer_care"):
            target_match = True
        elif field_key == "country_of_origin" and (r.get("rule_id") == "RULE_6_1_G" or r.get("field_key") == "country_of_origin"):
            target_match = True
        elif field_key in ["product_name", "generic_name"] and (r.get("rule_id") == "RULE_6_1_B" or r.get("field_key") == "generic_name"):
            target_match = True
        elif field_key == "font_size" and (r.get("rule_id") in ["RULE_7_FONT_SIZE", "RULE_7"] or r.get("field_key") == "font_size"):
            target_match = True
        elif field_key == "color_contrast" and (r.get("rule_id") in ["RULE_9_CONTRAST", "RULE_9"] or r.get("field_key") == "color_contrast"):
            target_match = True

        if target_match:
            r["extracted_value"] = new_val
            r["status"] = "PASS" if is_compliant_final else "FAIL"
            if is_manually_edited:
                r["remarks"] = f"Manually verified and marked {status_label_text} by {current_user.full_name} under PCR 2011."
                r["confidence"] = 1.0
            elif orig_record and orig_record.get("original_remarks"):
                r["remarks"] = orig_record.get("original_remarks")
            r["is_manually_edited"] = is_manually_edited

    job.rule_results = rules

    # Recalculate overall compliance verdict and statutory summary
    has_violation = any(r.get("status") == "FAIL" for r in rules)
    has_review = any(r.get("status") in ["NEEDS_REVIEW", "NEEDS_MANUAL_INSPECTION"] for r in rules)
    if has_violation:
        job.overall_compliance_verdict = "NON_COMPLIANT"
    elif has_review:
        job.overall_compliance_verdict = "FLAGGED_FOR_REVIEW"
    else:
        job.overall_compliance_verdict = "COMPLIANT"

    # Recalculate compliance score
    total_rules = len(rules)
    pass_count = sum(1 for r in rules if r.get("status") == "PASS")
    if total_rules > 0:
        job.compliance_score = round((pass_count / total_rules) * 100.0, 1)

    # Rebuild statutory_summary if compliant
    if job.overall_compliance_verdict == "COMPLIANT":
        master_report["statutory_summary"] = ["Nil Infractions Recorded: All mandatory packaging declarations comply strictly with the Legal Metrology (Packaged Commodities) Rules, 2011."]
        extracted["statutory_summary"] = master_report["statutory_summary"]

    # Synchronize repository Product status & updated timestamp
    if job.product:
        job.product.latest_compliance_status = job.overall_compliance_verdict
        job.product.updated_at = datetime.utcnow()
    job.completed_at = datetime.utcnow()

    extracted["master_report"] = master_report
    job.extracted_data = extracted
    job.edited_fields = edited

    # 5. Invalidate cached PDF/DOCX to ensure freshly updated downloads
    job.pdf_report_url = None
    job.docx_report_url = None

    db.commit()
    db.refresh(job)
    if job.product:
        db.refresh(job.product)

    product_name = job.product.product_name if job.product else "Packaged Commodity"
    brand_name = job.product.brand_name if job.product else None
    category = job.product.category if job.product else "Packaged Commodity"
    inspector_name = job.inspector.full_name if job.inspector else "Legal Metrology Inspector"
    panel_urls = job.image_urls or ([job.image_url] if job.image_url else [])

    return ScanJobResultResponse(
        id=job.id,
        product_id=job.product_id,
        product_name=product_name,
        brand_name=brand_name,
        category=category,
        inspector_id=job.inspector_id,
        inspector_name=inspector_name,
        image_url=job.image_url,
        image_urls=panel_urls,
        back_image_url=job.back_image_url,
        reference_scale_mm=job.reference_scale_mm,
        status=job.status,
        progress_percentage=job.progress_percentage,
        current_stage_message=job.current_stage_message,
        overall_compliance_verdict=job.overall_compliance_verdict or "PENDING",
        compliance_score=job.compliance_score or 0.0,
        extracted_data=job.extracted_data or {},
        rule_results=job.rule_results or [],
        raw_ocr_tokens=job.raw_ocr_tokens or [],
        clustered_blocks=job.clustered_blocks or [],
        cross_referenced_fields=job.cross_referenced_fields or [],
        pdf_report_url=job.pdf_report_url,
        docx_report_url=job.docx_report_url,
        inspector_notes=job.inspector_notes,
        edited_fields=job.edited_fields or {},
        detected_qr_url=job.detected_qr_url,
        code_to_enter=job.code_to_enter,
        qr_evidence_url=job.qr_evidence_url,
        available_compliance_qrs=(job.extracted_data or {}).get("available_compliance_qrs"),
        created_at=job.created_at,
        completed_at=job.completed_at
    )


@router.get("", response_model=List[ProductResponse])
def list_products(
    search: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    query = db.query(Product)
    if search:
        s = f"%{search}%"
        query = query.filter(or_(Product.product_name.ilike(s), Product.brand_name.ilike(s), Product.manufacturer_name.ilike(s)))
    if status and status != "ALL":
        query = query.filter(Product.latest_compliance_status == status)
    if category and category != "ALL":
        query = query.filter(Product.category == category)
    
    products = query.order_by(Product.updated_at.desc()).offset(skip).limit(limit).all()
    needs_commit = False
    for p in products:
        latest_scan = db.query(ScanJob).filter(
            ScanJob.product_id == p.id
        ).order_by(ScanJob.created_at.desc()).first()
        if latest_scan:
            setattr(p, "latest_scan_id", latest_scan.id)
            if latest_scan.overall_compliance_verdict and p.latest_compliance_status != latest_scan.overall_compliance_verdict:
                p.latest_compliance_status = latest_scan.overall_compliance_verdict
                p.updated_at = datetime.utcnow()
                needs_commit = True
            if not p.declared_net_quantity or not p.declared_mrp:
                ext = latest_scan.extracted_data or {}
                mand = (ext.get("master_report") or {}).get("mandatory_declarations", {})
                if not p.declared_net_quantity:
                    nq = ext.get("net_quantity", {}).get("value") or mand.get("net_quantity", {}).get("declared_value")
                    if not nq:
                        for r in (latest_scan.rule_results or []):
                            if r.get("rule_id") in ["RULE_6_1_C_AND_13", "RULE_6_1_C"] or r.get("field_key") == "net_quantity":
                                nq = r.get("extracted_value")
                                break
                    if nq and str(nq).strip().lower() not in ["not detected", "none", "-", "unresolved"]:
                        p.declared_net_quantity = str(nq).strip()
                if not p.declared_mrp:
                    m = ext.get("mrp", {}).get("value") or mand.get("mrp", {}).get("declared_value")
                    if not m:
                        for r in (latest_scan.rule_results or []):
                            if r.get("rule_id") == "RULE_6_1_E" or r.get("field_key") == "mrp":
                                m = r.get("extracted_value")
                                break
                    if m and str(m).strip().lower() not in ["not detected", "none", "-", "unresolved"]:
                        p.declared_mrp = str(m).strip()
    if needs_commit:
        db.commit()
    return products

@router.get("/{product_id}/history", response_model=ProductHistoryResponse)
def get_product_history(product_id: int, db: Session = Depends(get_db)):
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    scans = db.query(ScanJob).filter(ScanJob.product_id == product_id).order_by(ScanJob.created_at.desc()).all()
    history_items = []
    for s in scans:
        v_count = 0
        if s.rule_results:
            v_count = sum(1 for r in s.rule_results if r.get("status") == "FAIL")
        history_items.append(
            ProductHistoryItem(
                scan_id=s.id,
                created_at=s.created_at,
                status=s.status,
                compliance_score=s.compliance_score or 0.0,
                overall_compliance_verdict=s.overall_compliance_verdict or "PENDING",
                inspector_name=s.inspector.full_name if s.inspector else None,
                violations_count=v_count,
                image_url=s.image_url
            )
        )

    return ProductHistoryResponse(
        product=ProductResponse.from_orm(product),
        inspections=history_items
    )
