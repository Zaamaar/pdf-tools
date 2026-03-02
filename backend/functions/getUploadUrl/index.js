const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET_NAME = process.env.BUCKET_NAME;

exports.handler = async (event) => {

  try {

    const body = JSON.parse(event.body);
    const fileName = body.fileName;
    const fileType = body.fileType;

    if (!fileName || !fileType) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({
          error: 'fileName and fileType are required'
        })
      };
    }

    const fileKey = 'uploads/' + Date.now() + '-' + fileName;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
      ContentType: fileType
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        uploadUrl: uploadUrl,
        fileKey: fileKey
      })
    };

  } catch (error) {
    console.log('Error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'Internal server error',
        detail: error.message
      })
    };
  }

};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}