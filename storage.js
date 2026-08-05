const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const FOTOS_BUCKET = 'fotos';

const S3_ENDPOINT = process.env.S3_ENDPOINT || 'https://object.pscloud.io';
const S3_PUBLIC_BASE = (process.env.S3_PUBLIC_BASE || 'https://object.pscloud.io').replace(/\/$/, '');

const s3Client = new S3Client({
    region: process.env.YC_REGION || process.env.S3_REGION || 'eu-central-1',
    endpoint: S3_ENDPOINT,
    credentials: {
        accessKeyId: process.env.KZ_ACCESS_KEY,
        secretAccessKey: process.env.KZ_SECRET_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    signatureVersion: 'v4',
});

const normalizeKey = (key) => {
    if (!key || typeof key !== 'string') {
        throw new Error('filename (key) обязателен');
    }
    return key.replace(/^\/+/, '');
};

const assertCredentials = () => {
    if (!process.env.KZ_ACCESS_KEY || !process.env.KZ_SECRET_KEY) {
        throw new Error('KZ_ACCESS_KEY / KZ_SECRET_KEY не настроены');
    }
};

const uploadFotos = async (key, body, contentType) => {
    console.log("uploadFotos", key, body, contentType);
    const filePath = normalizeKey(key);
    if (!body) {
        throw new Error('Тело файла пустое');
    }
    
    console.log("assertCredentials");

    assertCredentials();

    console.log("PutObjectCommand");

    await s3Client.send(new PutObjectCommand({
        Bucket: FOTOS_BUCKET,
        Key: filePath,
        Body: body,
        ContentType: contentType || 'application/octet-stream',
        ChecksumAlgorithm: undefined,
    }));

    console.log("filepath");

    return {
        filePath,
        publicUrl: `${S3_PUBLIC_BASE}/${FOTOS_BUCKET}/${filePath}`,
    };
};

const getFotos = async (key) => {
    const filePath = normalizeKey(key);
    assertCredentials();

    try {
        const result = await s3Client.send(new GetObjectCommand({
            Bucket: FOTOS_BUCKET,
            Key: filePath,
        }));

        return {
            filePath,
            body: result.Body,
            contentType: result.ContentType || 'application/octet-stream',
            contentLength: result.ContentLength,
        };
    } catch (error) {
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
            const notFound = new Error('Файл не найден');
            notFound.status = 404;
            throw notFound;
        }
        throw error;
    }
};

const getFotosBuffer = async (key) => {
    const { filePath, body, contentType, contentLength } = await getFotos(key);
    const chunks = [];
    for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return {
        filePath,
        buffer: Buffer.concat(chunks),
        contentType,
        contentLength,
    };
};

const decodeBase64File = (input, fallbackMime = 'application/octet-stream') => {
    if (!input || typeof input !== 'string') {
        throw new Error('image/file обязателен (base64 или data URL)');
    }

    let data = input.trim();
    let mimeType = fallbackMime;

    const dataUrlMatch = data.match(/^data:([^;]+);base64,(.+)$/s);
    if (dataUrlMatch) {
        mimeType = dataUrlMatch[1] || fallbackMime;
        data = dataUrlMatch[2];
    } else if (data.includes(',')) {
        data = data.split(',').pop();
    }

    data = data.replace(/\s/g, '');
    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length) {
        throw new Error('Пустые данные файла после декодирования base64');
    }

    return { buffer, mimeType };
};

module.exports = {
    s3Client,
    uploadFotos,
    getFotos,
    getFotosBuffer,
    decodeBase64File,
    FOTOS_BUCKET,
    S3_PUBLIC_BASE,
};
