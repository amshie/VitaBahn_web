// Per-recipient document watermarking.
//
// Every PDF served from the data room is stamped, at request time, with the
// identity of the authenticated investor it is being released to (name, email,
// UTC timestamp). The stamp is both human-visible (a diagonal overlay + a footer
// identity band on every page) and machine-readable (the PDF Info dictionary), so
// a leaked copy is traceable to the account it was served to.
//
// Watermarking is traceability, not access control — access is already enforced
// upstream in /api/room/document before any bytes are read. If a document is not a
// parseable PDF (e.g. a spreadsheet, or a placeholder), it cannot be stamped in
// place; the caller is told (`applied:false`) so it can log that and still apply
// the view-only + logging controls. We never fail an authorised request just
// because the overlay could not be drawn.

import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFString } from 'pdf-lib';

const CONF_INK = rgb(0.043, 0.063, 0.075); // --ink #0B1013
const STAMP_TEAL = rgb(0.31, 0.70, 0.64); // --teal #4FB3A3
const BAND_TEXT = rgb(0.92, 0.94, 0.94);

const oneLine = (s, max = 140) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/[()\\]/g, ' ').trim().slice(0, max);

export function looksLikePdf(bytes, contentType) {
  if (contentType === 'application/pdf') return true;
  if (!bytes || bytes.length < 5) return false;
  return Buffer.from(bytes.slice(0, 5)).toString('latin1') === '%PDF-';
}

// Stamp `bytes` (a PDF) for `recipient` = { name, email, when }. Returns
// { bytes, applied }. On any parse/draw failure returns the original bytes with
// applied:false — the document is still access-controlled and logged upstream.
export async function watermarkPdf(bytes, recipient = {}) {
  const email = oneLine(recipient.email, 120) || 'unassigned';
  const name = oneLine(recipient.name, 80) || email;
  const when = oneLine(recipient.when, 40) || new Date().toISOString();
  const footer = `CONFIDENTIAL · released to ${name} · ${email} · ${when} · access logged`;
  const diagonal = `VitaBahn confidential — ${email}`;

  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();

      // Diagonal identity overlay, repeated down the page so a crop can't remove it.
      const size = Math.max(12, Math.min(20, width / 34));
      for (const frac of [0.2, 0.45, 0.7, 0.95]) {
        page.drawText(diagonal, {
          x: width * 0.06,
          y: height * frac,
          size,
          font,
          color: STAMP_TEAL,
          opacity: 0.1,
          rotate: degrees(30),
        });
      }

      // Solid footer band carrying the full, human-readable provenance line.
      page.drawRectangle({ x: 0, y: 0, width, height: 16, color: CONF_INK, opacity: 0.92 });
      page.drawText(footer.slice(0, Math.max(20, Math.floor(width / 4.4))), {
        x: 8,
        y: 5,
        size: 7,
        font,
        color: BAND_TEXT,
        opacity: 0.95,
      });
    }

    // Machine-readable provenance in the document Info dictionary. pdf-lib encodes
    // these as UTF-16 hex strings (readable by any PDF tool / pdf-lib, but not a
    // raw ASCII substring), so we ALSO add a literal-string /VbRecipient entry that
    // survives as greppable ASCII for quick forensic matching of a leaked file.
    pdf.setTitle(`VitaBahn confidential — released to ${email}`);
    pdf.setSubject(`Confidential VitaBahn investor material. Recipient ${name} ${email}. Served ${when}. View-only, access logged.`);
    pdf.setProducer('VitaBahn Data Room');
    pdf.setCreator('VitaBahn Data Room');
    pdf.setKeywords([`recipient:${email}`, `served:${when}`, 'confidential', 'view-tracked']);
    try {
      const infoRef = pdf.context.trailerInfo && pdf.context.trailerInfo.Info;
      const info = infoRef ? pdf.context.lookup(infoRef) : null;
      if (info && typeof info.set === 'function') {
        info.set(PDFName.of('VbRecipient'), PDFString.of(`recipient:${email} served:${when}`));
      }
    } catch { /* literal marker is best-effort; standard metadata already set */ }

    // useObjectStreams:false keeps the overlay + Info dictionary as plain PDF
    // objects (no cross-object compression), which keeps the provenance auditable.
    const out = await pdf.save({ useObjectStreams: false });
    return { bytes: Buffer.from(out), applied: true };
  } catch {
    return { bytes: Buffer.from(bytes), applied: false };
  }
}
