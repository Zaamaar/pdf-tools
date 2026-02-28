// ============================================
// SPLIT PDF — AWS Lambda Function
//
// What this function does:
// 1. Receives one S3 file key from the frontend
// 2. Downloads the PDF from S3
// 3. Splits it into individual pages using pdf-lib
// 4. Uploads each page as a separate PDF to S3
// 5. Returns a pre-signed URL for each individual page
// ============================================

const { PDFDocument } = require('pdf-lib');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET_NAME = process.env.BUCKET_NAME;

// ============================================
// streamToBuffer — identical to merge function
// Converts an S3 download stream into a Buffer
// so pdf-lib can read the complete file
// ============================================
async function streamToBuffer(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ============================================
// downloadPdfFromS3 — identical to merge function
// Downloads one PDF from S3 and returns it
// as a Buffer ready for pdf-lib to process
// ============================================
async function downloadPdfFromS3(fileKey) {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });
  const response = await s3.send(command);
  return await streamToBuffer(response.Body);
}

// ============================================
// uploadPageToS3
//
// Uploads a single extracted page to S3 and
// returns a pre-signed URL for that page.
//
// Each page gets a unique key using the timestamp
// AND the page number so files never overwrite
// each other even when processing simultaneously.
// ============================================
async function uploadPageToS3(pageBytes, pageNumber, timestamp) {
  // Build a unique S3 key for this specific page
  // Example: processed/split-1709123456789-page-1.pdf
  const outputKey = `processed/split-${timestamp}-page-${pageNumber}.pdf`;

  const uploadCommand = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: outputKey,
    Body: pageBytes,
    ContentType: 'application/pdf',
  });

  await s3.send(uploadCommand);

  // Generate a pre-signed download URL for this page
  const downloadCommand = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: outputKey,
  });

  const signedUrl = await getSignedUrl(s3, downloadCommand, { expiresIn: 3600 });

  // Return both the URL and the key
  // The frontend needs the URL to show download links
  // We return the page number so the frontend can label each link correctly
  return {
    pageNumber,
    downloadUrl: signedUrl,
    outputKey
  };
}

// ============================================
// MAIN HANDLER
// ============================================
exports.handler = async (event) => {

  const body = JSON.parse(event.body);

  // For split we only need one file key — the PDF to split
  const { fileKey } = body;

  // Validate — make sure a file key was provided
  if (!fileKey) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'Please provide a PDF file to split'
      })
    };
  }

  // Download the PDF from S3
  const pdfBuffer = await downloadPdfFromS3(fileKey);

  // Load it into pdf-lib for processing
  const pdf = await PDFDocument.load(pdfBuffer);

  // Get the total number of pages
  // getPageCount() returns an integer — e.g. 5 for a 5 page PDF
  const pageCount = pdf.getPageCount();

  // Validate — make sure the PDF has more than one page
  // Splitting a single page PDF makes no sense
  if (pageCount < 2) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'PDF must have at least 2 pages to split'
      })
    };
  }

  // Generate a timestamp once and reuse it for all page filenames
  // This ensures all pages from the same split job share the same
  // timestamp prefix making them easy to identify together
  const timestamp = Date.now();

  // Array to collect the results for each page
  const pages = [];

  // Loop through every page in the PDF
  // We use a standard for loop here so we have access to the index
  for (let i = 0; i < pageCount; i++) {

    // Create a brand new empty PDF document for this single page
    const singlePagePdf = await PDFDocument.create();

    // Copy just this one page from the original PDF
    // copyPages takes the source PDF and an array of page indices
    // [i] means copy only the page at index i
    const [copiedPage] = await singlePagePdf.copyPages(pdf, [i]);

    // Add the copied page to our single page document
    singlePagePdf.addPage(copiedPage);

    // Save this single page PDF as raw bytes
    const pageBytes = await singlePagePdf.save();

    // Upload to S3 and get a download URL
    // Page numbers shown to users start at 1 not 0
    // so we pass i + 1 as the page number
    const pageResult = await uploadPageToS3(pageBytes, i + 1, timestamp);

    pages.push(pageResult);
  }

  // Return all page download URLs to the frontend
  // The frontend shows one download button per page
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      message: `PDF split into ${pageCount} pages successfully`,
      pageCount: pageCount,
      pages: pages
      // pages looks like:
      // [
      //   { pageNumber: 1, downloadUrl: 'https://...', outputKey: '...' },
      //   { pageNumber: 2, downloadUrl: 'https://...', outputKey: '...' },
      //   { pageNumber: 3, downloadUrl: 'https://...', outputKey: '...' },
      // ]
    })
  };
};

// ============================================
// corsHeaders — identical to merge function
// Required for browser cross-origin requests
// ============================================
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
