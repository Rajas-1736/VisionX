import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { ScanJobResult } from '../types';
import { useAuth } from '../context/AuthContext';
import { 
  FileDown, Download, ShieldCheck, CheckCircle2, XCircle, 
  AlertTriangle, UploadCloud, ArrowLeft, Printer, Check, Mail,
  Edit3, X, Undo2, CheckCircle, ShieldAlert, RotateCcw, Pencil
} from 'lucide-react';

interface ReportPageProps {
  scanId: string | null;
  onBackToScan: () => void;
  fromTab?: string;
}

export const ReportPage: React.FC<ReportPageProps> = ({ scanId, onBackToScan, fromTab }) => {
  const { t } = useTranslation();
  const { canScanAndReport } = useAuth();

  const getBackButtonLabel = () => {
    if (fromTab === 'repository') return t('report.btn_back_repository', 'Back to Repository');
    if (fromTab === 'dashboard') return t('report.btn_back_dashboard', 'Back to Dashboard');
    return canScanAndReport ? t('report.btn_back_scan') : t('report.btn_back_repository', 'Back to Repository');
  };
  const [scan, setScan] = useState<ScanJobResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Evidence modal state
  const [showEvidenceModal, setShowEvidenceModal] = useState<boolean>(false);
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidenceNotes, setEvidenceNotes] = useState<string>('');
  const [uploadingEvidence, setUploadingEvidence] = useState<boolean>(false);
  const [evidenceSuccess, setEvidenceSuccess] = useState<boolean>(false);

  // Human-in-the-Loop Inline Editing State
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null);
  const [editInputValue, setEditInputValue] = useState<string>('');
  const [selectedStatusOverride, setSelectedStatusOverride] = useState<'COMPLIANT' | 'NON_COMPLIANT'>('COMPLIANT');
  const [savingFieldKey, setSavingFieldKey] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const startEditingField = (fieldKey: string, currentValue: string, currentIsFound?: boolean) => {
    setEditingFieldKey(fieldKey);
    setEditInputValue(currentValue === 'Not Declared on Pack' ? '' : currentValue);
    setSelectedStatusOverride(currentIsFound ? 'COMPLIANT' : 'NON_COMPLIANT');
    setEditError(null);
  };

  const cancelEditingField = () => {
    setEditingFieldKey(null);
    setEditInputValue('');
    setSelectedStatusOverride('COMPLIANT');
    setEditError(null);
  };

  const saveEditedField = async (fieldKey: string, statusOverride?: string) => {
    if (!scan) return;
    setSavingFieldKey(fieldKey);
    setEditError(null);
    const finalStatus = statusOverride || selectedStatusOverride;
    try {
      const updatedScan = await api.products.editField(scan.id, {
        field_key: fieldKey,
        new_value: editInputValue,
        revert: false,
        status: finalStatus
      });
      setScan(updatedScan);
      setEditingFieldKey(null);
      setEditInputValue('');
    } catch (err: any) {
      setEditError(err.response?.data?.detail || 'Failed to save edits');
    } finally {
      setSavingFieldKey(null);
    }
  };

  const revertFieldToAi = async (fieldKey: string) => {
    if (!scan) return;
    setSavingFieldKey(fieldKey);
    setEditError(null);
    try {
      const updatedScan = await api.products.editField(scan.id, {
        field_key: fieldKey,
        new_value: '',
        revert: true
      });
      setScan(updatedScan);
      if (editingFieldKey === fieldKey) {
        setEditingFieldKey(null);
        setEditInputValue('');
      }
    } catch (err: any) {
      setEditError(err.response?.data?.detail || 'Failed to revert edits');
    } finally {
      setSavingFieldKey(null);
    }
  };

  useEffect(() => {
    const fetchReportData = async () => {
      if (!scanId) {
        // Fetch the most recent scan if scanId is not passed
        try {
          const stats = await api.dashboard.getStats();
          if (stats.recent_scans && stats.recent_scans.length > 0) {
            const firstId = stats.recent_scans[0].id;
            const res = await api.products.getScanResult(firstId);
            setScan(res);
          } else {
            setError('No inspection records available to generate report.');
          }
        } catch (e) {
          setError('Failed to load inspection report');
        } finally {
          setLoading(false);
        }
        return;
      }

      try {
        setLoading(true);
        const res = await api.products.getScanResult(scanId);
        setScan(res);
      } catch (err: any) {
        setError(err.response?.data?.detail || 'Failed to load report');
      } finally {
        setLoading(false);
      }
    };

    fetchReportData();
  }, [scanId]);

  // Track whether the PDF report has been downloaded
  const [hasDownloadedPdf, setHasDownloadedPdf] = useState<boolean>(false);

  // NOTE: Downloaded PDF & Word (.docx) compliance reports are intentionally generated by the backend
  // in English only to maintain uniform legal and evidentiary standards under LMR 2011.
  const handleDownloadPdf = () => {
    if (scan) {
      window.open(api.reports.getPdfDownloadUrl(scan.id), '_blank');
      setHasDownloadedPdf(true);
    }
  };

  const handleDownloadDocx = () => {
    if (scan) {
      window.open(api.reports.getDocxDownloadUrl(scan.id), '_blank');
    }
  };

  const handleOpenGmail = () => {
    if (!scan) return;

    const prodName = scan.product_name || 'Packaged Commodity';
    const verdict = scan.overall_compliance_verdict || 'INSPECTION COMPLETE';
    const score = scan.compliance_score !== undefined ? `${scan.compliance_score}%` : 'N/A';
    const dateStr = scan.created_at ? new Date(scan.created_at).toLocaleDateString() : new Date().toLocaleDateString();

    const subject = `VisionX Statutory Inspection Report: ${prodName} [${verdict}]`;
    const body = `Respected Official,\n\nPlease find attached the statutory compliance inspection report for "${prodName}" generated via VisionX (Legal Metrology Compliance Enforcement System).\n\n--- INSPECTION SUMMARY ---\n• Product Name: ${prodName}\n• Category: ${scan.category || 'Packaged Goods'}\n• Final Verdict: ${verdict}\n• Compliance Score: ${score}\n• Inspection Case ID: ${scan.id}\n• Date of Inspection: ${dateStr}\n• Inspecting Officer: ${scan.inspector_name || 'Legal Metrology Enforcement Officer'}\n---------------------------\n\n(Note: The official inspection PDF report has been downloaded to this device and can be attached to this email.)\n\nRegards,\nLegal Metrology Enforcement Directorate\nMinistry of Consumer Affairs, Government of India`;

    const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);

    if (isMobile) {
      // Launch native email client / Gmail on mobile via RFC-compliant mailto
      const mailtoUri = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\n/g, '\r\n'))}`;
      const link = document.createElement('a');
      link.href = mailtoUri;
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        try { document.body.removeChild(link); } catch (_) {}
      }, 150);
    } else {
      // On Laptop/Desktop: open Gmail Web compose in a new browser tab
      const gmailWebUrl = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.open(gmailWebUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const handleAttachEvidence = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scan || !evidenceFile) return;

    setUploadingEvidence(true);
    const formData = new FormData();
    formData.append('evidence_image', evidenceFile);
    formData.append('notes', evidenceNotes);

    try {
      await api.reports.attachEvidence(scan.id, formData);
      setEvidenceSuccess(true);
      setTimeout(() => {
        setShowEvidenceModal(false);
        setEvidenceSuccess(false);
        setEvidenceFile(null);
        setEvidenceNotes('');
      }, 1500);
    } catch (err) {
      console.error('Evidence upload failed', err);
    } finally {
      setUploadingEvidence(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] space-y-3">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-semibold text-slate-500">{t('common.loading')}</span>
      </div>
    );
  }

  if (error || !scan) {
    return (
      <div className="bg-white p-8 rounded-xl border border-slate-200 text-center max-w-md mx-auto space-y-4">
        <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto" />
        <h3 className="text-sm font-bold text-slate-800">{error || 'Report not found'}</h3>
        <button
          onClick={onBackToScan}
          className="px-4 py-2 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition cursor-pointer"
        >
          {getBackButtonLabel()}
        </button>
      </div>
    );
  }

  const isCompliant = scan.overall_compliance_verdict === 'COMPLIANT';
  const isViolation = scan.overall_compliance_verdict === 'NON_COMPLIANT';

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-16 animate-in fade-in slide-in-from-bottom-3 duration-500">
      
      {/* Statutory Language Notice: PDF/DOCX Reports are in English only */}
      <div className="bg-blue-50/90 border border-blue-200 text-blue-900 px-4 py-2.5 rounded-xl text-xs flex items-center gap-2.5 shadow-xs print:hidden">
        <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0" />
        <span className="leading-relaxed font-medium">
          {t('report.official_language_note')}
        </span>
      </div>

      {/* Top Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm print:hidden">
        <button
          onClick={onBackToScan}
          className="flex items-center space-x-1.5 text-xs text-slate-600 hover:text-slate-900 font-semibold cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{getBackButtonLabel()}</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {canScanAndReport && (
            <button
              onClick={() => setShowEvidenceModal(true)}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-semibold transition cursor-pointer"
            >
              <UploadCloud className="w-3.5 h-3.5" />
              <span>{t('report.btn_attach_evidence')}</span>
            </button>
          )}

          {canScanAndReport && (
            <button
              onClick={handleDownloadDocx}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 text-xs font-semibold transition shadow-sm cursor-pointer"
            >
              <FileDown className="w-3.5 h-3.5" />
              <span>{t('report.btn_download_docx')}</span>
            </button>
          )}

          {canScanAndReport && (
            <button
              onClick={handleDownloadPdf}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-sm cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t('report.btn_download_pdf')}</span>
            </button>
          )}

          {canScanAndReport && hasDownloadedPdf && (
            <button
              onClick={handleOpenGmail}
              style={{ backgroundColor: '#ea4335', color: '#ffffff' }}
              className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-white text-xs font-bold transition shadow-md cursor-pointer"
              title="Forward downloaded inspection report via Gmail"
            >
              <Mail className="w-3.5 h-3.5 shrink-0" style={{ stroke: '#ffffff' }} />
              <span style={{ color: '#ffffff' }}>{t('report.btn_mail_report', 'Mail via Gmail')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Official Printable Report Sheet */}
      <div className="bg-white rounded-2xl shadow-xl border border-slate-300 p-4 sm:p-8 md:p-12 space-y-6 text-slate-800 print:border-none print:shadow-none">
        
        {/* Government Letterhead Header */}
        <div className="text-center border-b-2 border-blue-900 pb-6 space-y-1">
          <div className="text-xs font-bold uppercase tracking-widest text-slate-600">
            Government of India • Ministry of Consumer Affairs, Food & Public Distribution
          </div>
          <div className="text-sm font-bold uppercase text-slate-800">
            Department of Legal Metrology — Enforcement Division
          </div>
          <h2 className="text-2xl font-black text-blue-950 uppercase tracking-tight pt-2">
            Packaged Commodity Compliance Inspection Report
          </h2>
          <p className="text-[11px] text-slate-500">
            Issued under Section 18 & 52 of Legal Metrology Act, 2009 read with Legal Metrology (Packaged Commodities) Rules, 2011
          </p>
        </div>

        {/* Metadata Summary Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 bg-slate-50 p-4 rounded-lg border border-slate-200 text-xs">
          <div>
            <span className="text-slate-500 font-semibold block text-[10px] uppercase">Inspection ID</span>
            <span className="font-mono font-bold text-slate-800">{scan.id.slice(0, 16)}</span>
          </div>
          <div>
            <span className="text-slate-500 font-semibold block text-[10px] uppercase">Inspecting Officer</span>
            <span className="font-bold text-slate-800">{scan.inspector_name || 'Enforcement Officer'}</span>
          </div>
          <div>
            <span className="text-slate-500 font-semibold block text-[10px] uppercase">Commodity Category</span>
            <span className="font-bold text-slate-800">{scan.category || 'Packaged Commodity'}</span>
          </div>
          <div>
            <span className="text-slate-500 font-semibold block text-[10px] uppercase">Physical Reference Scale</span>
            <span className="font-mono font-bold text-slate-800">
              {scan.reference_scale_mm ? `${scan.reference_scale_mm} mm` : 'None Provided'}
            </span>
          </div>
        </div>

        {/* Verdict Banner */}
        <div className={`p-4 rounded-xl border text-center space-y-1 ${
          isCompliant
            ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
            : isViolation
            ? 'bg-rose-50 border-rose-300 text-rose-900'
            : 'bg-amber-50 border-amber-300 text-amber-900'
        }`}>
          <div className="flex items-center justify-center space-x-2">
            {isCompliant ? (
              <CheckCircle2 className="w-6 h-6 text-emerald-600" />
            ) : isViolation ? (
              <XCircle className="w-6 h-6 text-rose-600" />
            ) : (
              <AlertTriangle className="w-6 h-6 text-amber-600" />
            )}
            <span className="text-lg font-black tracking-wide uppercase">
              Verdict: {scan.overall_compliance_verdict.replace(/_/g, ' ')}
            </span>
          </div>
          <p className="text-xs font-semibold">
            Compliance Score: {scan.compliance_score}% • Statutory evaluation completed under 2011 Rules
          </p>
        </div>

        {/* Section 1: Rule-by-rule Checklist */}
        <div className="space-y-3">
          <h3 className="text-xs font-extrabold uppercase tracking-wider text-blue-900 border-b pb-1">
            1. Rule-by-Rule Compliance Checklist
          </h3>
          
          <div className="overflow-x-auto w-full">
            <table className="w-full text-left text-xs border-collapse border border-slate-200 min-w-[560px]">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  <th className="p-2.5 border border-slate-200 w-1/3">Rule & Legal Citation</th>
                  <th className="p-2.5 border border-slate-200 w-24 text-center">Verdict</th>
                  <th className="p-2.5 border border-slate-200">Declared Text Found</th>
                  <th className="p-2.5 border border-slate-200">Inspector Findings</th>
                </tr>
              </thead>
              <tbody>
                {scan.rule_results.map((rule) => (
                  <tr key={rule.rule_id} className="hover:bg-slate-50/50">
                    <td className="p-2.5 border border-slate-200">
                      <div className="font-bold text-slate-900">{rule.title}</div>
                      <div className="text-[10px] font-mono text-slate-500">{rule.clause_reference}</div>
                    </td>
                    <td className="p-2.5 border border-slate-200 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                        rule.status === 'PASS'
                          ? 'bg-emerald-100 text-emerald-800'
                          : rule.status === 'FAIL'
                          ? 'bg-rose-100 text-rose-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}>
                        {rule.status}
                      </span>
                    </td>
                    <td className="p-2.5 border border-slate-200 font-mono text-[11px] text-slate-700">
                      {rule.extracted_value || <span className="text-slate-400 italic">Not Declared</span>}
                    </td>
                    <td className="p-2.5 border border-slate-200 text-[11px] text-slate-600">
                      {rule.remarks}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Section 2: Structured Mandatory Declarations Table (Auditable Evidence) */}
        {(() => {
          const master = scan.extracted_data?.master_report || (scan as any).master_report;
          const mand = master?.mandatory_declarations || {};
          const mfg = master?.manufacturer_details || scan.extracted_data?.manufacturer_details || {};

          const fieldDefinitions: {
            key: string;
            defaultLabel: string;
            fallbackValue?: string;
            fallbackRemarks?: string;
            fallbackStatus?: string;
          }[] = [
            {
              key: 'product_name',
              defaultLabel: 'Product / Brand Name',
              fallbackValue: master?.product_name || (scan as any).product_name,
              fallbackRemarks: 'Identified from packaging panel.',
              fallbackStatus: 'found',
            },
            {
              key: 'generic_name',
              defaultLabel: 'Common / Generic Commodity Name (Rule 6(1)(b))',
              fallbackValue: mand?.generic_commodity_name?.declared_value,
              fallbackRemarks: mand?.generic_commodity_name?.compliance_remarks,
              fallbackStatus: mand?.generic_commodity_name?.is_compliant ? 'found' : 'missing',
            },
            {
              key: 'manufacturer_name',
              defaultLabel: 'Manufacturer / Packer Legal Name (Rule 6(1)(a))',
              fallbackValue: mfg?.resolved_manufacturer_name,
              fallbackRemarks: mfg?.compliance_remarks,
              fallbackStatus: mfg?.is_compliant ? 'found' : (mfg?.resolution_method?.includes('QR') ? 'review_required' : 'invalid'),
            },
            {
              key: 'manufacturer_address',
              defaultLabel: 'Complete Physical Factory Address (Rule 6(1)(a))',
              fallbackValue: mfg?.resolved_address,
              fallbackRemarks: mfg?.compliance_remarks,
              fallbackStatus: mfg?.is_compliant ? 'found' : (mfg?.resolution_method?.includes('QR') ? 'review_required' : 'invalid'),
            },
            {
              key: 'net_quantity',
              defaultLabel: 'Net Quantity in Metric SI Units (Rule 6(1)(c) & Rule 13)',
              fallbackValue: mand?.net_quantity?.declared_value,
              fallbackRemarks: mand?.net_quantity?.compliance_remarks,
              fallbackStatus: mand?.net_quantity?.is_compliant ? 'found' : 'invalid',
            },
            {
              key: 'mrp',
              defaultLabel: 'Maximum Retail Price [MRP] (Rule 6(1)(e))',
              fallbackValue: mand?.mrp?.declared_value,
              fallbackRemarks: mand?.mrp?.compliance_remarks,
              fallbackStatus: mand?.mrp?.is_compliant ? 'found' : 'invalid',
            },
            {
              key: 'unit_sale_price',
              defaultLabel: 'Unit Sale Price [USP] (Rule 6(1)(e) Amendment)',
              fallbackValue: mand?.unit_sale_price?.declared_value,
              fallbackRemarks: mand?.unit_sale_price?.compliance_remarks,
              fallbackStatus: mand?.unit_sale_price?.is_compliant ? 'found' : 'missing',
            },
            {
              key: 'mfg_date',
              defaultLabel: 'Month & Year of Manufacture / Packing (Rule 6(1)(d))',
              fallbackValue: mand?.mfg_or_pkd_date?.declared_value,
              fallbackRemarks: mand?.mfg_or_pkd_date?.compliance_remarks,
              fallbackStatus: mand?.mfg_or_pkd_date?.is_compliant ? 'found' : 'missing',
            },
            {
              key: 'consumer_care',
              defaultLabel: 'Consumer Care Contact Details (Rule 6(1)(f))',
              fallbackValue: mand?.consumer_care_details?.declared_value,
              fallbackRemarks: mand?.consumer_care_details?.compliance_remarks,
              fallbackStatus: mand?.consumer_care_details?.is_compliant ? 'found' : 'missing',
            },
            {
              key: 'country_of_origin',
              defaultLabel: 'Country of Origin Declaration (Rule 6(1)(g))',
              fallbackValue: mand?.country_of_origin?.declared_value,
              fallbackRemarks: mand?.country_of_origin?.compliance_remarks,
              fallbackStatus: mand?.country_of_origin?.is_compliant ? 'found' : 'missing',
            },
          ];

          return (
            <div className="space-y-3">
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-blue-900 border-b pb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className="bg-blue-800 text-white text-[10px] font-black px-1.5 py-0.5 rounded shadow-xs">2</span>
                  <span>Verification and Editing Window (Structured Declarations)</span>
                </span>
                <span className="text-[10px] text-slate-500 font-mono font-normal">Table 1.0 — Legal Metrology Rules, 2011</span>
              </h3>
              
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse border border-slate-200">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr>
                      <th className="p-2.5 border border-slate-200 w-1/4">Declaration Field</th>
                      <th className="p-2.5 border border-slate-200 w-2/5">Declared Value Found & Editing Controls</th>
                      <th className="p-2.5 border border-slate-200 w-24 text-center">Status</th>
                      <th className="p-2.5 border border-slate-200 w-20 text-center">Confidence</th>
                      <th className="p-2.5 border border-slate-200">Statutory Audit Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fieldDefinitions.map((def) => {
                      const f = scan.extracted_data?.[def.key];
                      const isEdited = Boolean(scan.edited_fields?.[def.key] || f?.is_manually_edited);
                      const editedInfo = scan.edited_fields?.[def.key];
                      const val = (editedInfo?.edited_value) || f?.value || def.fallbackValue || 'Not Declared on Pack';
                      const label = f?.label || def.defaultLabel;

                      // Link with scan.rule_results to ensure consistent status
                      const linkedRule = (scan.rule_results || []).find(r => 
                        r.field_key === def.key || 
                        (def.key === 'unit_sale_price' && (r.rule_id === 'RULE_6_1_E_USP' || r.field_key === 'unit_sale_price')) ||
                        (def.key === 'net_quantity' && (r.rule_id === 'RULE_6_1_C_AND_13' || r.rule_id === 'RULE_6_1_C')) ||
                        (def.key === 'mrp' && r.rule_id === 'RULE_6_1_E') ||
                        (def.key === 'mfg_date' && r.rule_id === 'RULE_6_1_D') ||
                        (def.key === 'consumer_care' && r.rule_id === 'RULE_6_1_F') ||
                        (def.key === 'country_of_origin' && r.rule_id === 'RULE_6_1_G') ||
                        (def.key === 'manufacturer_name' && r.rule_id === 'RULE_6_1_A') ||
                        (def.key === 'generic_name' && r.rule_id === 'RULE_6_1_B')
                      );

                      let isFound = false;
                      let isReview = false;

                      if (editedInfo) {
                        if ((editedInfo as any).status_override === 'COMPLIANT' || (editedInfo as any).compliance_status === true) {
                          isFound = true;
                        } else if ((editedInfo as any).status_override === 'NON_COMPLIANT' || (editedInfo as any).compliance_status === false) {
                          isFound = false;
                        } else if (linkedRule) {
                          isFound = linkedRule.status === 'PASS';
                          isReview = linkedRule.status === 'NEEDS_REVIEW';
                        } else {
                          isFound = val !== 'Not Declared on Pack' && val !== '';
                        }
                      } else if (linkedRule) {
                        isFound = linkedRule.status === 'PASS';
                        isReview = linkedRule.status === 'NEEDS_REVIEW';
                      } else {
                        const status = f?.status || def.fallbackStatus || (val !== 'Not Declared on Pack' ? 'found' : 'missing');
                        isFound = status === 'found' || status === 'valid' || status === 'COMPLIANT';
                        isReview = status === 'review_required' || status === 'NEEDS_REVIEW' || status === 'NEEDS_MANUAL_INSPECTION';
                      }

                      const remarks = editedInfo
                        ? `Manually verified as ${isFound ? 'COMPLIANT' : 'NON-COMPLIANT'} by inspector under PCR 2011.`
                        : (linkedRule?.remarks || f?.validation_remarks || def.fallbackRemarks || 'Verified under Legal Metrology Rules, 2011.');
                      const conf = isEdited ? '100%' : (f?.confidence ? `${Math.round(f.confidence * 100)}%` : '95%');

                      const isCurrentlyEditing = editingFieldKey === def.key;
                      const isCurrentlySaving = savingFieldKey === def.key;

                      return (
                        <tr key={def.key} className={`transition-colors ${isCurrentlyEditing ? 'bg-amber-50/40' : 'hover:bg-slate-50/50'}`}>
                          <td className="p-2.5 border border-slate-200">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-semibold text-slate-800">{label}</span>
                              {isEdited && (
                                <span 
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-extrabold uppercase tracking-wide bg-amber-100 text-amber-900 border border-amber-300 shadow-2xs"
                                  title={editedInfo?.edited_by ? `Manually verified by ${editedInfo.edited_by}` : 'Manually verified by inspector'}
                                >
                                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                                  {t('report.badge_manual_edit', 'Manual Edit')}
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="p-2.5 border border-slate-200">
                            {isCurrentlyEditing ? (
                              <div className="space-y-2 animate-in fade-in duration-200 py-1">
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="text"
                                    autoFocus
                                    value={editInputValue}
                                    onChange={(e) => setEditInputValue(e.target.value)}
                                    placeholder="Enter verified declaration..."
                                    className="w-full text-xs font-mono px-2.5 py-1.5 bg-white border-2 border-amber-400 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 text-slate-900 shadow-xs"
                                  />
                                  <button
                                    type="button"
                                    disabled={isCurrentlySaving}
                                    onClick={cancelEditingField}
                                    className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-md transition cursor-pointer"
                                    title="Close edit box"
                                  >
                                    <X className="w-4 h-4" />
                                  </button>
                                </div>

                                {/* 4 Explicit Inspector Action Options */}
                                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                  {/* 1. Non-compliant */}
                                  <button
                                    type="button"
                                    disabled={isCurrentlySaving}
                                    onClick={() => {
                                      setSelectedStatusOverride('NON_COMPLIANT');
                                      saveEditedField(def.key, 'NON_COMPLIANT');
                                    }}
                                    className={`px-2.5 py-1 rounded text-[11px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50 ${
                                      selectedStatusOverride === 'NON_COMPLIANT'
                                        ? 'bg-rose-600 text-white shadow-sm ring-2 ring-rose-300'
                                        : 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-300'
                                    }`}
                                    title="Mark this field as Non-compliant (Violation)"
                                  >
                                    <ShieldAlert className="w-3.5 h-3.5" />
                                    <span>1. Non-compliant</span>
                                  </button>

                                  {/* 2. Compliant */}
                                  <button
                                    type="button"
                                    disabled={isCurrentlySaving}
                                    onClick={() => {
                                      setSelectedStatusOverride('COMPLIANT');
                                      saveEditedField(def.key, 'COMPLIANT');
                                    }}
                                    className={`px-2.5 py-1 rounded text-[11px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50 ${
                                      selectedStatusOverride === 'COMPLIANT'
                                        ? 'bg-emerald-600 text-white shadow-sm ring-2 ring-emerald-300'
                                        : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-300'
                                    }`}
                                    title="Mark this field as Compliant (Pass)"
                                  >
                                    <CheckCircle className="w-3.5 h-3.5" />
                                    <span>2. Compliant</span>
                                  </button>

                                  {/* 3. Save changes */}
                                  <button
                                    type="button"
                                    disabled={isCurrentlySaving}
                                    onClick={() => saveEditedField(def.key, selectedStatusOverride)}
                                    className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-[11px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50 shadow-xs active:scale-95"
                                    title="Save text and compliance changes"
                                  >
                                    <Check className="w-3.5 h-3.5" />
                                    <span>3. Save changes</span>
                                  </button>

                                  {/* 4. Undo changes */}
                                  <button
                                    type="button"
                                    disabled={isCurrentlySaving}
                                    onClick={() => revertFieldToAi(def.key)}
                                    className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-[11px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50 shadow-2xs"
                                    title="Undo changes and revert to original AI detection"
                                  >
                                    <RotateCcw className="w-3 h-3 text-slate-600" />
                                    <span>4. Undo changes</span>
                                  </button>
                                </div>

                                {editError && (
                                  <p className="text-[10px] text-rose-600 font-medium">{editError}</p>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center justify-between gap-2 group">
                                <span className="font-mono text-[11px] text-slate-900 break-words">
                                  {val}
                                </span>
                                {canScanAndReport && (
                                  <button
                                    type="button"
                                    onClick={() => startEditingField(def.key, val, isFound)}
                                    className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition shrink-0 cursor-pointer"
                                    title="Edit field (Pencil icon)"
                                  >
                                    <Pencil className="w-3.5 h-3.5 text-slate-600 hover:text-blue-600" />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>

                          <td className="p-2.5 border border-slate-200 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              isFound
                                ? 'bg-emerald-100 text-emerald-800'
                                : isReview
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}>
                              {isFound ? 'PASS' : isReview ? 'REVIEW' : 'FAIL'}
                            </span>
                          </td>
                          <td className="p-2.5 border border-slate-200 text-center font-mono text-[11px] text-slate-600">
                            {conf}
                          </td>
                          <td className="p-2.5 border border-slate-200 text-[11px] text-slate-600">
                            {remarks}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}

        {/* Section 3: USP Mathematical Cross-Verification */}
        {(() => {
          const master = scan.extracted_data?.master_report || (scan as any).master_report;
          const usp = master?.usp_cross_verification || scan.extracted_data?.usp_cross_verification;
          if (!usp || !usp.mrp_numeric) return null;

          const isUspEdited = Boolean(scan.edited_fields?.['unit_sale_price']);
          const isUspCompliant = isUspEdited 
            ? ((scan.edited_fields?.['unit_sale_price'] as any)?.status_override === 'COMPLIANT' || (scan.edited_fields?.['unit_sale_price'] as any)?.compliance_status === true)
            : usp.is_compliant;
          const uspRemarks = isUspEdited
            ? `Manually verified as ${isUspCompliant ? 'COMPLIANT' : 'NON-COMPLIANT'} by inspector under PCR 2011.`
            : usp.remarks;

          return (
            <div className="space-y-3">
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-blue-900 border-b pb-1 flex items-center justify-between">
                <span>3. Unit Sale Price (USP) Mathematical Cross-Verification (Rule 6(1)(e))</span>
                <span className="text-[10px] text-slate-500 font-mono font-normal">Table 2.0 — Mathematical Audit</span>
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse border border-slate-200">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr>
                      <th className="p-2.5 border border-slate-200">Declared MRP</th>
                      <th className="p-2.5 border border-slate-200">Net Quantity</th>
                      <th className="p-2.5 border border-slate-200">Declared USP</th>
                      <th className="p-2.5 border border-slate-200">Calculated Base USP</th>
                      <th className="p-2.5 border border-slate-200 text-center w-24">Verdict</th>
                      <th className="p-2.5 border border-slate-200">Audit Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="p-2.5 border border-slate-200 font-mono">₹ {usp.mrp_numeric ?? 'N/A'}</td>
                      <td className="p-2.5 border border-slate-200 font-mono">{usp.quantity_numeric ? `${usp.quantity_numeric} ${usp.quantity_unit || ''}` : 'N/A'}</td>
                      <td className="p-2.5 border border-slate-200 font-mono">{scan.edited_fields?.['unit_sale_price']?.edited_value || usp.declared_usp_raw || (usp.declared_usp_numeric ? `₹ ${usp.declared_usp_numeric}` : 'N/A')}</td>
                      <td className="p-2.5 border border-slate-200 font-mono">₹ {usp.calculated_usp_per_base_unit} {usp.calculated_usp_unit}</td>
                      <td className="p-2.5 border border-slate-200 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          isUspCompliant ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                        }`}>
                          {isUspCompliant ? 'PASS' : 'FAIL'}
                        </span>
                      </td>
                      <td className="p-2.5 border border-slate-200 text-[11px] text-slate-600">{uspRemarks}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}

        {/* Section 4: Second Schedule Anti-Shrinkflation Audit */}
        {(() => {
          const master = scan.extracted_data?.master_report || (scan as any).master_report;
          const shrink = master?.second_schedule_shrinkflation_audit || scan.extracted_data?.second_schedule_shrinkflation_audit;
          if (!shrink || !shrink.is_second_schedule_commodity) return null;

          return (
            <div className="space-y-3">
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-blue-900 border-b pb-1 flex items-center justify-between">
                <span>4. Second Schedule Prescribed Pack Sizes & Anti-Shrinkflation Audit (Rule 5)</span>
                <span className="text-[10px] text-slate-500 font-mono font-normal">Table 3.0 — Second Schedule Conformance</span>
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse border border-slate-200">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr>
                      <th className="p-2.5 border border-slate-200">Prescribed Commodity Category</th>
                      <th className="p-2.5 border border-slate-200">Declared Pack Size</th>
                      <th className="p-2.5 border border-slate-200">Nearest Standard Benchmark</th>
                      <th className="p-2.5 border border-slate-200">Deviation / Downsizing</th>
                      <th className="p-2.5 border border-slate-200 text-center w-24">Verdict</th>
                      <th className="p-2.5 border border-slate-200">Statutory Analysis</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="p-2.5 border border-slate-200 font-semibold">{shrink.matched_commodity_category || 'Not regulated under Second Schedule'}</td>
                      <td className="p-2.5 border border-slate-200 font-mono">{shrink.declared_quantity || 'N/A'}</td>
                      <td className="p-2.5 border border-slate-200 font-mono">{shrink.nearest_standard_pack_size || 'N/A'}</td>
                      <td className="p-2.5 border border-slate-200 font-mono text-rose-600 font-bold">
                        {shrink.shrinkage_percentage !== undefined && shrink.shrinkage_percentage !== null ? `${shrink.shrinkage_percentage}%` : '0%'}
                      </td>
                      <td className="p-2.5 border border-slate-200 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          shrink.is_compliant ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                        }`}>
                          {shrink.is_compliant ? 'PASS' : 'FAIL'}
                        </span>
                      </td>
                      <td className="p-2.5 border border-slate-200 text-[11px] text-slate-600">{shrink.remarks}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}

        {/* Section 5: Physical & Visual Metrology (Font & Contrast) */}
        {(() => {
          const master = scan.extracted_data?.master_report || (scan as any).master_report;
          const metro = master?.visual_and_metrology_audit || scan.extracted_data?.visual_and_metrology_audit;
          if (!metro) return null;
          const font = metro.rule_7_font_size;
          const contrast = metro.rule_9_color_contrast;
          if (!font && !contrast) return null;

          // Metrology parameter definitions for Table 4.0
          const metroRows = [
            font ? {
              key: 'font_size',
              label: 'Table-I Numeral & Letter Height (Rule 7(2))',
              displayValue: font.measured_numeral_height_mm ? `${font.measured_numeral_height_mm} mm` : 'Visual Inspection',
              benchmark: font.statutory_min_height_mm ? `Min ${font.statutory_min_height_mm} mm` : 'Table-I Area Scale',
              isCompliant: font.is_compliant,
              remarks: font.remarks || 'Table-I Area Scale verification.',
              linkedRuleId: 'RULE_7_FONT_SIZE'
            } : null,
            contrast ? {
              key: 'color_contrast',
              label: 'Background Color Contrast (Rule 9(1)(b))',
              displayValue: contrast.contrast_ratio ? `Ratio: ${contrast.contrast_ratio}` : 'N/A',
              benchmark: 'Min 3.0:1 Contrast',
              isCompliant: contrast.is_compliant,
              remarks: contrast.remarks || 'Color contrast visual check.',
              linkedRuleId: 'RULE_9_CONTRAST'
            } : null,
          ].filter(Boolean) as Array<{
            key: string;
            label: string;
            displayValue: string;
            benchmark: string;
            isCompliant: boolean;
            remarks: string;
            linkedRuleId: string;
          }>;

          return (
            <div className="space-y-3">
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-blue-900 border-b pb-1 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className="bg-blue-800 text-white text-[10px] font-black px-1.5 py-0.5 rounded shadow-xs">5</span>
                  <span>Physical & Visual Metrology Audit (Rule 7 & 9)</span>
                </span>
                <span className="text-[10px] text-slate-500 font-mono font-normal">Table 4.0 — Optical Verification</span>
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse border border-slate-200">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr>
                      <th className="p-2.5 border border-slate-200 w-1/3">Metrology Parameter</th>
                      <th className="p-2.5 border border-slate-200 w-2/5">Measured Value & Editing Controls</th>
                      <th className="p-2.5 border border-slate-200">Statutory Benchmark</th>
                      <th className="p-2.5 border border-slate-200 text-center w-24">Verdict</th>
                      <th className="p-2.5 border border-slate-200">Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metroRows.map((mRow) => {
                      const isEdited = Boolean(scan.edited_fields?.[mRow.key] || scan.extracted_data?.[mRow.key]?.is_manually_edited);
                      const editedInfo = scan.edited_fields?.[mRow.key];
                      const linkedRule = (scan.rule_results || []).find(r => r.rule_id === mRow.linkedRuleId || r.field_key === mRow.key);

                      let isCompliantFinal = mRow.isCompliant;
                      if (editedInfo) {
                        if ((editedInfo as any).status_override === 'COMPLIANT' || (editedInfo as any).compliance_status === true) {
                          isCompliantFinal = true;
                        } else if ((editedInfo as any).status_override === 'NON_COMPLIANT' || (editedInfo as any).compliance_status === false) {
                          isCompliantFinal = false;
                        }
                      } else if (linkedRule) {
                        isCompliantFinal = linkedRule.status === 'PASS';
                      }

                      const finalVal = editedInfo?.edited_value || mRow.displayValue;
                      const finalRemarks = editedInfo
                        ? `Manually verified as ${isCompliantFinal ? 'COMPLIANT' : 'NON-COMPLIANT'} by inspector under PCR 2011.`
                        : (linkedRule?.remarks || mRow.remarks);

                      const isCurrentlyEditing = editingFieldKey === mRow.key;
                      const isCurrentlySaving = savingFieldKey === mRow.key;

                      return (
                        <tr key={mRow.key} className={`transition-colors ${isCurrentlyEditing ? 'bg-amber-50/40' : 'hover:bg-slate-50/50'}`}>
                          <td className="p-2.5 border border-slate-200 font-semibold">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-slate-800">{mRow.label}</span>
                              {isEdited && (
                                <span 
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-extrabold uppercase tracking-wide bg-amber-100 text-amber-900 border border-amber-300 shadow-2xs"
                                  title={editedInfo?.edited_by ? `Manually verified by ${editedInfo.edited_by}` : 'Manually verified by inspector'}
                                >
                                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                                  {t('report.badge_manual_edit', 'Manual Edit')}
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="p-2.5 border border-slate-200">
                            {isCurrentlyEditing ? (
                              <div className="space-y-2 animate-in fade-in duration-200 py-1">
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="text"
                                    autoFocus
                                    value={editInputValue}
                                    onChange={(e) => setEditInputValue(e.target.value)}
                                    placeholder={mRow.key === 'font_size' ? 'Enter numeral height (e.g. 2.5 mm)...' : 'Enter contrast ratio (e.g. 4.2:1)...'}
                                    className="w-full text-xs font-mono px-2.5 py-1.5 bg-white border-2 border-amber-400 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 text-slate-900 shadow-xs"
                                  />
                                  <button
                                    type="button"
                                    disabled={isCurrentlySaving}
                                    onClick={cancelEditingField}
                                    className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-md transition cursor-pointer"
                                    title="Close edit box"
                                  >
                                    <X className="w-4 h-4" />
                                  </button>
                                </div>

                                {/* 4 Explicit Inspector Action Options */}
                                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                  {/* 1. Non-compliant */}
                                  <button
                                    type="button"
                                    disabled={isCurrentlySaving}
                                    onClick={() => {
                                      setSelectedStatusOverride('NON_COMPLIANT');
                                      saveEditedField(mRow.key, 'NON_COMPLIANT');
                                    }}
                                    className={`px-2.5 py-1 rounded text-[11px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50 ${
                                      selectedStatusOverride === 'NON_COMPLIANT'
                                        ? 'bg-rose-600 text-white shadow-sm ring-2 ring-rose-300'
                                        : 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-300'
                                    }`}
                                    title="Mark this metrology parameter as Non-compliant (Violation)"
                                  >
                                    <ShieldAlert className="w-3.5 h-3.5" />
                                    <span>1. Non-compliant</span>
                                  </button>

                                  {/* 2. Compliant */}
                                  <button
                                    type="button"
                                    disabled={isCurrentlySaving}
                                    onClick={() => {
                                      setSelectedStatusOverride('COMPLIANT');
                                      saveEditedField(mRow.key, 'COMPLIANT');
                                    }}
                                    className={`px-2.5 py-1 rounded text-[11px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50 ${
                                      selectedStatusOverride === 'COMPLIANT'
                                        ? 'bg-emerald-600 text-white shadow-sm ring-2 ring-emerald-300'
                                        : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-300'
                                    }`}
                                    title="Mark this metrology parameter as Compliant (Pass)"
                                  >
                                    <CheckCircle className="w-3.5 h-3.5" />
                                    <span>2. Compliant</span>
                                  </button>

                                  {/* 3. Save changes */}
                                  <button
                                    type="button"
                                    disabled={isCurrentlySaving}
                                    onClick={() => saveEditedField(mRow.key, selectedStatusOverride)}
                                    className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-[11px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50 shadow-xs active:scale-95"
                                    title="Save value and compliance status"
                                  >
                                    <Check className="w-3.5 h-3.5" />
                                    <span>3. Save changes</span>
                                  </button>

                                  {/* 4. Undo changes */}
                                  <button
                                    type="button"
                                    disabled={isCurrentlySaving}
                                    onClick={() => revertFieldToAi(mRow.key)}
                                    className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-[11px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50 shadow-2xs"
                                    title="Undo changes and revert to original AI measurement"
                                  >
                                    <RotateCcw className="w-3 h-3 text-slate-600" />
                                    <span>4. Undo changes</span>
                                  </button>
                                </div>

                                {editError && editingFieldKey === mRow.key && (
                                  <p className="text-[10px] text-rose-600 font-medium">{editError}</p>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center justify-between gap-2 group">
                                <span className="font-mono text-[11px] text-slate-900 break-words">
                                  {finalVal}
                                </span>
                                {canScanAndReport && (
                                  <button
                                    type="button"
                                    onClick={() => startEditingField(mRow.key, finalVal, isCompliantFinal)}
                                    className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition shrink-0 cursor-pointer"
                                    title="Edit metrology parameter (Pencil icon)"
                                  >
                                    <Pencil className="w-3.5 h-3.5 text-slate-600 hover:text-blue-600" />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>

                          <td className="p-2.5 border border-slate-200 font-mono">{mRow.benchmark}</td>

                          <td className="p-2.5 border border-slate-200 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              isCompliantFinal ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                            }`}>
                              {isCompliantFinal ? 'PASS' : 'FAIL'}
                            </span>
                          </td>

                          <td className="p-2.5 border border-slate-200 text-[11px] text-slate-600">
                            {finalRemarks}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}

        {/* Section 6: Statutory Violations & Penalties Schedule */}
        {(() => {
          const master = scan.extracted_data?.master_report || (scan as any).master_report;
          const rawSummary: string[] = master?.statutory_summary || [];
          const actualViolations = rawSummary.filter(
            (item: string) => !item.toLowerCase().includes('comply strictly') && !item.toLowerCase().includes('no statutory') && !item.toLowerCase().includes('nil')
          );

          return (
            <div className="space-y-3">
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-blue-900 border-b pb-1 flex items-center justify-between">
                <span>
                  {actualViolations.length > 0
                    ? '6. Statutory Violations & Enforcement Penalties (Legal Metrology Act, 2009)'
                    : '6. Statutory Enforcement Summary (Legal Metrology Act, 2009)'}
                </span>
                <span className="text-[10px] text-slate-500 font-mono font-normal">
                  {actualViolations.length > 0 ? 'Section 36(1) Schedule' : 'Statutory Conformity'}
                </span>
              </h3>
              {actualViolations.length > 0 ? (
                <div className="bg-rose-50 p-3 rounded-lg border border-rose-200 space-y-2">
                  {actualViolations.map((item: string, idx: number) => (
                    <div key={idx} className="text-xs text-rose-800 flex items-start space-x-2">
                      <span className="w-4 h-4 rounded-full bg-rose-200 text-rose-900 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                        {idx + 1}
                      </span>
                      <span className="leading-snug font-medium">Violation {idx + 1}: {item}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-emerald-50 p-3.5 rounded-lg border border-emerald-200 text-xs text-emerald-800 flex items-center gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="font-semibold leading-relaxed">
                    Nil Infractions Recorded: All mandatory packaging declarations comply strictly with the Legal Metrology (Packaged Commodities) Rules, 2011. No statutory penalties under Section 36(1) or Section 39 applicable.
                  </span>
                </div>
              )}
            </div>
          );
        })()}

        {/* Section 7: Attached Evidence & Notes */}
        {scan.inspector_notes && (
          <div className="space-y-2">
            <h3 className="text-xs font-extrabold uppercase tracking-wider text-blue-900 border-b pb-1">
              7. Officer Remarks & Evidence Notes
            </h3>
            <div className="p-3 bg-slate-50 rounded border border-slate-200 text-xs text-slate-700 font-mono leading-relaxed">
              {scan.inspector_notes}
            </div>
          </div>
        )}

        {/* Statutory Explanatory Notice for Manual Evidentiary Badges */}
        <div className="bg-amber-50/80 border border-amber-200 border-l-4 border-l-amber-500 rounded-lg p-3.5 text-xs text-amber-950 flex items-start gap-3 shadow-2xs">
          <div className="p-1.5 bg-amber-100 text-amber-800 rounded-md shrink-0 mt-0.5">
            <Edit3 className="w-4 h-4" />
          </div>
          <div className="space-y-1">
            <div className="font-bold flex items-center gap-2">
              <span>Statutory Notice on Evidentiary Badges</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9px] font-extrabold uppercase bg-amber-200/80 text-amber-900 border border-amber-300">
                Manual Edit
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-amber-900/90 font-medium">
              {t('report.badge_explanatory_notice', 'Statutory Notice on Evidentiary Badges: Fields marked with the amber [Manual Edit] badge represent statutory declaration values physically verified, inspected, and updated by the authorized enforcement officer, superseding automated AI extractions under the Legal Metrology Act, 2009. Fields without this badge represent automated multimodal extractions.')}
            </p>
          </div>
        </div>

        {/* Official Signature Footer */}
        <div className="pt-10 flex justify-between items-end text-xs text-slate-600">
          <div className="space-y-1">
            <div className="w-48 border-t border-slate-700 pt-1 font-bold text-slate-800">
              {scan.inspector_name || 'Authorized Enforcement Officer'}
            </div>
            <div className="text-[10px] text-slate-500">Legal Metrology Department</div>
          </div>

          <div className="text-right space-y-1">
            <div className="w-48 border-t border-slate-700 pt-1 font-bold text-slate-800 ml-auto">
              Digital Signature & Stamp
            </div>
            <div className="text-[10px] text-slate-500">Ministry of Consumer Affairs</div>
          </div>
        </div>

      </div>

      {/* Attach Evidence Modal */}
      {showEvidenceModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
              <UploadCloud className="w-4 h-4 text-blue-600" />
              <span>{t('report.modal_evidence_title')}</span>
            </h3>

            {evidenceSuccess ? (
              <div className="p-4 bg-emerald-50 text-emerald-800 rounded-lg text-xs flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-600" />
                <span>{t('report.modal_evidence_success')}</span>
              </div>
            ) : (
              <form onSubmit={handleAttachEvidence} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {t('report.modal_evidence_photo')}
                  </label>
                  <input
                    type="file"
                    accept="image/*"
                    required
                    onChange={(e) => setEvidenceFile(e.target.files?.[0] || null)}
                    className="w-full text-xs text-slate-600"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {t('report.modal_evidence_notes')}
                  </label>
                  <textarea
                    rows={2}
                    value={evidenceNotes}
                    onChange={(e) => setEvidenceNotes(e.target.value)}
                    placeholder={t('report.modal_evidence_notes_placeholder')}
                    className="w-full text-xs p-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>

                <div className="flex justify-end space-x-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowEvidenceModal(false)}
                    className="px-3 py-1.5 rounded-lg border text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={uploadingEvidence || !evidenceFile}
                    className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-50 cursor-pointer"
                  >
                    {uploadingEvidence ? t('report.modal_evidence_uploading') : t('report.modal_evidence_btn_upload')}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

    </div>
  );
};
