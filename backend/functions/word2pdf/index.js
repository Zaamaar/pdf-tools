const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const mammoth = require('mammoth');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET_NAME = process.env.BUCKET_NAME;

async function streamToBuffer(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function downloadFromS3(fileKey) {
  const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: fileKey });
  const response = await s3.send(command);
  return await streamToBuffer(response.Body);
}

// Replace common special characters that WinAnsi can't encode
function sanitizeText(text) {
  return text
    .replace(/[\u2018\u2019]/g, "'")   // smart single quotes
    .replace(/[\u201C\u201D]/g, '"')   // smart double quotes
    .replace(/\u2013/g, '-')           // en dash
    .replace(/\u2014/g, '--')          // em dash
    .replace(/\u2026/g, '...')         // ellipsis
    .replace(/\u00A0/g, ' ')           // non-breaking space
    .replace(/\u2022/g, '*')           // bullet
    .replace(/[^\x00-\xFF]/g, '?');    // replace any remaining non-latin chars
}

function wrapText(text, font, fontSize, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;
    try {
      if (font.widthOfTextAtSize(testLine, fontSize) > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    } catch (e) {
      // If encoding fails, push current line and start fresh
      if (currentLine) lines.push(currentLine);
      currentLine = '';
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length ? lines : [''];
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { fileKey } = body;
    if (!fileKey) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Please provide a Word document' }) };
    }

    const docxBuffer = await downloadFromS3(fileKey);
    const result = await mammoth.extractRawText({ buffer: docxBuffer });
    const text = sanitizeText(result.value);

    const pdfDoc = await PDFDocument.create();
    const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 595, pageHeight = 842, margin = 60;
    const maxWidth = pageWidth - margin * 2;
    const bodySize = 11, headingSize = 14;
    const lineHeight = bodySize * 1.6, headingLineHeight = headingSize * 1.8;

    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    for (const rawLine of text.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        y -= lineHeight * 0.5;
        if (y < margin) { page = pdfDoc.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }
        continue;
      }

      const isHeading = trimmed.length < 80 && (trimmed === trimmed.toUpperCase() || /^[A-Z][^.!?,]*$/.test(trimmed));
      const font = isHeading ? boldFont : regularFont;
      const fontSize = isHeading ? headingSize : bodySize;
      const lh = isHeading ? headingLineHeight : lineHeight;
      if (isHeading) y -= lh * 0.4;

      for (const wl of wrapText(trimmed, font, fontSize, maxWidth)) {
        if (y < margin + lh) { page = pdfDoc.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }
        try {
          page.drawText(wl, { x: margin, y, font, size: fontSize, color: rgb(0.1, 0.1, 0.1) });
        } catch (e) {
          // Skip lines that still can't be encoded
        }
        y -= lh;
      }
    }

    const pdfBytes = await pdfDoc.save();
    const outputKey = 'processed/document-' + Date.now() + '.pdf';
    await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: outputKey, Body: pdfBytes, ContentType: 'application/pdf' }));
    const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: outputKey }), { expiresIn: 3600 });

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ message: 'Word converted to PDF successfully', downloadUrl })
    };

  } catch (error) {
    console.log('Error:', error);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Processing failed', detail: error.message }) };
  }
};

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}
