// ============================================
// GET UPLOAD URL — AWS Lambda Function
//
// What this function does:
// Generates a pre-signed S3 URL that the
// frontend uses to upload a file DIRECTLY
// to S3 without going through Lambda.
//
// Why this exists:
// Lambda has a 6MB request body limit.
// PDFs can be much larger.
// Pre-signed upload URLs bypass Lambda entirely
// for the upload — the browser uploads straight
// to S3 then tells Lambda the S3 key to process.
//
// Flow:
// 1. Frontend calls POST /get-upload-url
// 2. This function generates a pre-signed PUT URL
// 3. Frontend uses that URL to PUT the file to S3
// 4. Frontend calls /merge, /split etc with the S3 key
// ============================================

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET_NAME = process.env.BUCKET_NAME;

exports.handler = async (event) => {

  const body = JSON.parse(event.body);

  // fileName — the original name of the file
  // fileType — the MIME type e.g. 'application/pdf'
  const { fileName, fileType } = body;

  if (!fileName || !fileType) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'fileName and fileType are required'
      })
    };
  }

  // Generate a unique key for this upload
  // Date.now() ensures no two uploads have the same key
  // even if users upload files with the same name
  const fileKey = `uploads/${Date.now()}-${fileName}`;

  // Create a PutObject command — this is what the
  // browser will use to upload the file to S3
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
    ContentType: fileType,
  });

  // Generate a pre-signed URL for the PUT operation
  // expiresIn: 300 — URL expires after 5 minutes
  // Short expiry because this is an upload URL
  // The user should upload immediately after receiving it
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

  // Return both the upload URL and the file key
  // The frontend needs:
  // - uploadUrl to PUT the file to S3
  // - fileKey to tell Lambda which file to process
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      uploadUrl,
      fileKey
    })
  };
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
```

Save with `Cmd + S`.

---

**The complete upload flow now looks like this:**
```
Browser selects a PDF file
        │
        │ POST /get-upload-url
        │ { fileName, fileType }
        ▼
GetUploadUrl Lambda
        │
        │ returns { uploadUrl, fileKey }
        ▼
Browser PUTs file directly to S3
using the pre-signed uploadUrl
        │
        │ File is now in S3 at fileKey
        │
        │ POST /merge
        │ { fileKeys: [fileKey] }
        ▼
Merge Lambda downloads from S3
processes and uploads result
        │
        │ returns { downloadUrl }
        ▼
Browser shows download button