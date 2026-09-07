require('dotenv').config();
const express                   = require('express');
const http                      = require('http');
const socketIo                  = require('socket.io');
const cors                      = require('cors');
const { SOCKET_CONFIG, PORT }   = require('./config');
const SocketHandlers            = require('./socketHandlers');
const { closePool }             = require('./services');
const { uploadFotos, getFotos, resolveImageInput } = require('./storage');
const nodemailer                = require('nodemailer');
const multer                    = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl }          = require("@aws-sdk/s3-request-presigner");

const VK_CONFIG = {
    URL:                        process.env.VK_URL,
    ACCESS_KEY:                 process.env.VK_ACCESS_KEY,
    SECRET_KEY:                 process.env.VK_SECRET_KEY,
    BUCKET:                     process.env.VK_BUCKET
};

const vkClient = new S3Client({
    region: 'ru-msk',
    endpoint: VK_CONFIG.URL,
    credentials: {
        accessKeyId: VK_CONFIG.ACCESS_KEY,
        secretAccessKey: VK_CONFIG.SECRET_KEY
    },
    forcePathStyle: false,
    disableHostPrefix: false,
    requestChecksumCalculation: "WHEN_REQUIRED",
    signatureVersion: 'v4'
});

const s3Client = new S3Client({
    region:                     process.env.YC_REGION || "eu-central-1",
    endpoint:                   "https://object.pscloud.io",
    forcePathStyle:             true,
    credentials: {
        accessKeyId:            process.env.KZ_ACCESS_KEY,
        secretAccessKey:        process.env.KZ_SECRET_KEY,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
});

const transporter = nodemailer.createTransport({
    host:       process.env.SMTP_HOST || 'smtp.mail.ru',
    port:       Number(process.env.SMTP_PORT) || 465,
    secure:     true,
    auth: {
        user:     process.env.SMTP_USER,
        pass:     process.env.SMTP_PASS
    }
});

const jsonDefault = express.json({ limit: '2mb' });
const jsonLarge = express.json({ limit: '50mb' });
const urlencodedDefault = express.urlencoded({ extended: true, limit: '2mb' });

const LARGE_BODY_PATHS = new Set([
    '/api/sendimage',
    '/api/sendEmail',
    '/api/set_location',
    '/api/check_passport_photo',
    '/api/check_passport_registration',
]);

const MULTIPART_PATHS = new Set(['/api/upload_doc', '/api/uploadFotos']);

const uploadDoc = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
});

class App {

    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = null;
        this.socketHandlers = null;
        this.isShuttingDown = false;

        this.setupCORS();
        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketIO();
        this.setupErrorHandling();
    }

    createCorsOriginChecker(label) {
        const allowedOrigins = this.getAllowedOrigins();

        return (origin, callback) => {
            if (!origin) return callback(null, true);

            const allowed =
                allowedOrigins.includes(origin) ||
                origin.startsWith('file://') ||
                origin.startsWith('ionic://') ||
                origin.startsWith('capacitor://');

            if (allowed) {
                return callback(null, true);
            }

            console.log(`❌ ${label} заблокирован origin:`, origin);
            return callback(new Error('Not allowed by CORS'));
        };
    }

    setupCORS() {
        const corsOptions = {
            origin: this.createCorsOriginChecker('CORS'),
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
            credentials: true,
            optionsSuccessStatus: 200,
            preflightContinue: false,
            maxAge: 86400
        };

        this.app.use('/api', cors(corsOptions));
        this.app.options('/api/*', cors(corsOptions));

        console.log('✅ CORS настроен для API');
        console.log('📋 Разрешенные origins:', this.getAllowedOrigins());
    }

    getAllowedOrigins() {
        const origins = [
            'http://localhost:8100',
            'http://localhost:8101',
            'https://localhost:3000',
            'https://localhost:3001',
            'https://localhost:8080',
            'https://localhost:8100',
            'https://localhost',
            'http://127.0.0.1:3000',
            'http://127.0.0.1:3001',
            'http://127.0.0.1:8080',
            'http://127.0.0.1:8100',
            'https://127.0.0.1:3000',
            'https://127.0.0.1:3001',
            'https://127.0.0.1:8080',
            'https://127.0.0.1:8100',
            'http://10.30.20.12:8100',
            'http://192.168.10.116:8100',
            'https://paitza.com',
            'https://gruzreis.ru',
            'https://www.gruzreis.ru',
            'https://grusvreis.ru',
            'https://www.grusvreis.ru',
            'capacitor://localhost',
            'ionic://localhost',
            'file://'
        ];

        if (process.env.CORS_ORIGIN) {
            process.env.CORS_ORIGIN.split(',').forEach(origin => {
                const trimmed = origin.trim();
                if (trimmed && !origins.includes(trimmed)) {
                    origins.push(trimmed);
                }
            });
        }

        return origins;
    }

    setupMiddleware() {
        this.app.use((req, res, next) => {
            // multipart обрабатывает multer на маршруте — json parser пропускаем
            if (MULTIPART_PATHS.has(req.path)) {
                return next();
            }
            const parser = LARGE_BODY_PATHS.has(req.path) ? jsonLarge : jsonDefault;
            parser(req, res, (err) => {
                if (err) return next(err);
                urlencodedDefault(req, res, next);
            });
        });

        this.app.use((req, res, next) => {
            if (process.env.LOG_HTTP === '1') {
                console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
            }
            next();
        });
    }

    /** Вызов SP без fake-socket emit; опционально уведомить online-получателя */
    async runProcedure(path, params) {
        return this.socketHandlers.handleMethod(
            { emit: () => {} },
            path,
            params
        );
    }

    async requireToken(tokenOrQuery) {
        const token = typeof tokenOrQuery === 'string'
            ? tokenOrQuery
            : tokenOrQuery?.token;
        if (!token) return null;
        return this.socketHandlers.checkToken({ token });
    }

    async notifyChatRecipient(recipientId, cargo, senderId) {
        const recipientSocket = this.socketHandlers.socketManager.findSocket(recipientId);
        if (!recipientSocket?.userToken) return;

        await this.socketHandlers.handleMethod(recipientSocket, 'get_chats', {
            token: recipientSocket.userToken
        });
        await this.socketHandlers.handleMethod(recipientSocket, 'get_messages', {
            token: recipientSocket.userToken,
            cargo,
            recipient: senderId
        });
    }

    multerSingle(req, res, next) {
        uploadDoc.single('file')(req, res, (err) => {
            if (err) {
                const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
                return res.status(status).json({
                    success: false,
                    message: err.code === 'LIMIT_FILE_SIZE'
                        ? 'Файл больше 20 MB'
                        : err.message,
                });
            }
            next();
        });
    }

    async handleUploadFotos(req, res) {
        try {
            console.log("begin", req.body );
            const token = req.body?.token;
            const filename = req.body?.filename;
            const contentType = req.body?.contentType || req.file?.mimetype;

            console.log("first 1", token )
            const user = await this.requireToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: 'Неверный токен' });
            }
            if (!filename) {
                return res.status(400).json({ success: false, message: 'filename обязателен' });
            }
            if (!req.file?.buffer?.length) {
                return res.status(400).json({ success: false, message: 'file обязателен' });
            }

            console.log("user", user )

            const result = await uploadFotos(filename, req.file.buffer, contentType);
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('❌ uploadFotos:', error.message);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    async handleGetFotos(req, res) {
        try {
            const token = req.query.token;
            const key = req.query.filename || req.query.key;

            const user = await this.requireToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: 'Неверный токен' });
            }
            if (!key) {
                return res.status(400).json({ success: false, message: 'filename (key) обязателен' });
            }

            const { body, contentType, contentLength, filePath } = await getFotos(key);

            res.setHeader('Content-Type', contentType);
            if (contentLength != null) {
                res.setHeader('Content-Length', String(contentLength));
            }
            res.setHeader(
                'Content-Disposition',
                `inline; filename="${encodeURIComponent(filePath.split('/').pop() || 'file')}"`
            );
            res.setHeader('Cache-Control', 'private, max-age=300');

            if (typeof body.pipe === 'function') {
                body.pipe(res);
            } else if (body && typeof body.transformToByteArray === 'function') {
                const bytes = await body.transformToByteArray();
                res.send(Buffer.from(bytes));
            } else {
                const chunks = [];
                for await (const chunk of body) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
                res.send(Buffer.concat(chunks));
            }
        } catch (error) {
            console.error('❌ getFotos:', error.message);
            if (res.headersSent) {
                return res.destroy(error);
            }
            res.status(error.status || 500).json({ success: false, message: error.message });
        }
    }

    setupRoutes() {

        this.app.get('/api/status',                                  (req, res) => {
            res.json({
                status: 'running',
                connections: this.io ? this.io.engine.clientsCount : 0,
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
        });

        this.app.get('/api/getVersion',                              (req, res) => {
            res.json({ success: true, data: process.env.APP_VERSION || '1.0.1' });
        });

        this.app.post('/api/uploadFotos',                            (req, res, next) => this.multerSingle(req, res, next),
                                                                     (req, res) => this.handleUploadFotos(req, res)
        );

        this.app.get('/api/getFotos',                                (req, res) => this.handleGetFotos(req, res));


        this.app.post('/api/check_passport_photo',             async (req, res) => {
            try {
                const { token, expected } = req.body || {};
                const user = await this.requireToken(token);
                if (!user) {
                    return res.status(401).json({ success: false, message: 'Неверный токен' });
                }

                const resolved = await resolveImageInput(req.body || {});
                const result = await this.socketHandlers.passportAI.verifyPassportPhoto(
                    resolved.image,
                    { mimeType: resolved.mimeType, expected }
                );
                if (resolved.filePath) {
                    result.filePath = resolved.filePath;
                }
                res.json(result);
            } catch (error) {
                res.status(error.status || 500).json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/check_passport_registration',      async (req, res) => {
            try {
                const { token, expected } = req.body || {};
                const user = await this.requireToken(token);
                if (!user) {
                    return res.status(401).json({ success: false, message: 'Неверный токен' });
                }

                const resolved = await resolveImageInput(req.body || {});
                const result = await this.socketHandlers.passportAI.verifyPassportRegistration(
                    resolved.image,
                    { mimeType: resolved.mimeType, expected }
                );
                if (resolved.filePath) {
                    result.filePath = resolved.filePath;
                }
                res.json(result);
            } catch (error) {
                res.status(error.status || 500).json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/sendimage',                        async (req, res) => {
            try {
                const { token, recipient, cargo, image } = req.body;
                const user = await this.requireToken(token);
                if (!user) {
                    return res.status(401).json({ success: false, message: 'Неверный токен' });
                }

                const result = await this.runProcedure('send_image', {
                    token, recipient, cargo, image, message: ''
                });

                if (result?.success) {
                    await this.notifyChatRecipient(recipient, cargo, user.id);
                }

                res.json(result);
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/set_location',                     async (req, res) => {
            try {
                const { token, recipient, cargo, image } = req.body;
                const user = await this.requireToken(token);
                if (!user) {
                    return res.status(401).json({ success: false, message: 'Неверный токен' });
                }

                const result = await this.runProcedure('set_location', {
                    token, recipient, cargo, image, message: ''
                });

                if (result?.success && recipient) {
                    const recipientSocket = this.socketHandlers.socketManager.findSocket(recipient);
                    if (recipientSocket) {
                        recipientSocket.emit('set_location', result);
                    }
                }

                res.json(result);
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/sendEmail',                        async (req, res) => {
            try {
                const { token, email, pdf } = req.body;
                const user = await this.requireToken(token);
                if (!user) {
                    return res.status(401).json({ success: false, message: 'Неверный токен' });
                }
                if (!email || !pdf) {
                    return res.status(400).json({ success: false, message: 'email и pdf обязательны' });
                }
                if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
                    return res.status(500).json({ success: false, message: 'SMTP не настроен (SMTP_USER/SMTP_PASS)' });
                }

                const mailOptions = {
                    from: process.env.SMTP_USER,
                    to: email,
                    subject: 'Счет на оплату',
                    text: 'См. вложение.',
                    attachments: [
                        {
                            filename: 'invoice.pdf',
                            content: pdf,
                            encoding: 'base64',
                            contentType: 'application/pdf',
                            disposition: 'attachment'
                        }
                    ]
                };

                transporter.sendMail(mailOptions, (error, info) => {
                    if (error) {
                        console.error('Ошибка SMTP:', error.message);
                        return res.json({ success: false, message: error.message });
                    }
                    console.log('Письмо отправлено:', info.response);
                    res.json({ success: true, message: 'Письмо отправлено' });
                });
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        const syncRoutes = [
            ['/api/company', 'upd_company'],
            ['/api/kassa', 'upd_kassa'],
            ['/api/cargos', 'upd_cargo'],
            ['/api/deals', 'upd_deals'],
            ['/api/deal_details', 'upd_deal_details']
        ];

        for (const [route, procedure] of syncRoutes) {
            this.app.post(route, async (req, res) => {
                try {
                    const data = req.body;
                    const user = await this.requireToken(data);
                    if (!user) {
                        return res.status(401).json({ success: false, message: 'Неверный токен' });
                    }
                    const result = await this.runProcedure(procedure, data);
                    res.json(result);
                } catch (error) {
                    res.json({ success: false, message: error.message });
                }
            });
        }

        this.app.post('/api/tinkoff_payment',                  async (req, res) => {
            try {
                const body = req.body || {};
                console.log('Tinkoff callback:', {
                    Status:                 body.Status,
                    PaymentId:              body.PaymentId,
                    OrderId:                body.OrderId
                });

                if (body.OrderId && body.Status) {
                    const statusMap = {
                        CONFIRMED:          2,
                        AUTHORIZED:         2,
                        DEADLINE_EXPIRED:   3,
                        REJECTED:           4,
                        CANCELED:           4,
                        REVERSED:           4
                    };
                    const orderStatus = statusMap[body.Status];
                    if (orderStatus !== undefined) {
                        await this.runProcedure('set_payment', {
                            id:             body.OrderId,
                            paymentId:      body.PaymentId,
                            orderStatus
                        });
                    }
                }

                // Tinkoff ожидает OK
                res.json({ success: true });
            } catch (error) {
                console.error('Tinkoff callback error:', error.message);
                res.json({ success: true });
            }
        });

        this.app.get('/api/get_token',                         async (req, res) => {
            try {
                const result = await this.socketHandlers.checkToken(req.query);
                if (!result) {
                    return res.status(401).json({ success: false, message: 'Неверный токен' });
                }
                res.json({ success: true, data: result });
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        this.app.get('/api/getUrl',                            async (req, res) => {
            try {
                const result = await this.socketHandlers.checkToken(req.query);

                if (!result) {
                    return res.status(401).json({ error: 'Неверный токен' });
                }

                const fileName = `${req.query.cargo_id}/${result.id}/${req.query.recipient_id}/${req.query.filename}`;
                const bucketName = 'chat-fotos';

                const command = new PutObjectCommand({
                    Bucket: bucketName,
                    Key: fileName,
                    ContentType: '',
                    ChecksumAlgorithm: undefined
                });

                const presignedUrl = await getSignedUrl(s3Client, command, {
                    expiresIn: 60,
                    signableHeaders: new Set(['host']),
                });

                res.json({
                    uploadUrl:  presignedUrl,
                    filePath:   fileName,
                    publicUrl:  `https://object.pscloud.io/${bucketName}/${fileName}`
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/uploadURL',                         async (req, res) => {
            try {
                const result = await this.socketHandlers.checkToken(req.query);

                if (!result) {
                    return res.status(401).json({ error: 'Неверный токен' });
                }

                const fileName                          = req.query.filename;

                console.log('fileName', fileName);

                const bucketName                        = 'docfotos';

                const command1                          = new PutObjectCommand({
                    Bucket: bucketName,
                    Key: fileName,
                    ContentType: '',
                    ChecksumAlgorithm: undefined
                });

                const presignedUrl                      = await getSignedUrl(s3Client, command1, {
                    expiresIn: 60,
                    signableHeaders: new Set(['host']),
                });

                const command2                          = new GetObjectCommand({
                    Bucket: bucketName,
                    Key: fileName,
                    ContentType: '',
                    ChecksumAlgorithm: undefined
                });

                const signUrl                           = await getSignedUrl(s3Client, command2, {
                    expiresIn: 60,
                    signableHeaders: new Set(['host']),
                });

                res.json({
                    uploadUrl:               presignedUrl,
                    filePath:                fileName,
                    signUrl:                 signUrl,
                    publicUrl:               `https://object.pscloud.io/${bucketName}/${fileName}`
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/get_VKUrl',                         async (req, res) => {
            try {
                const user = await this.requireToken(req.query);
                if (!user) {
                    return res.status(401).json({ error: true, message: 'Неверный токен' });
                }

                const { filename } = req.query;
                if (!filename) {
                    return res.status(400).json({ error: true, message: 'filename обязателен' });
                }

                const command = new PutObjectCommand({
                    Bucket: VK_CONFIG.BUCKET,
                    Key: filename,
                });

                let uploadUrl = await getSignedUrl(vkClient, command, {
                    expiresIn: 3600,
                    signableHeaders: new Set(['host']),
                });

                const urlObj = new URL(uploadUrl);
                urlObj.searchParams.set('X-Amz-Content-Sha256', 'UNSIGNED_PAYLOAD');
                ['x-id', 'x-amz-user-agent'].forEach(p => urlObj.searchParams.delete(p));

                uploadUrl = urlObj.toString();
                const fileUrl = `https://${VK_CONFIG.BUCKET}.hb.ru-msk.vkcloud-storage.ru/${filename}`;

                res.json({ uploadUrl, fileUrl });
            } catch (error) {
                console.error('❌ get_VKUrl:', error.message);
                res.status(500).json({ error: true, message: error.message });
            }
        });

        // Заглушки для страницы удаления: нужны хранимки / SMS-флоу на бэке
        this.app.post('/api/auth/send-delete-code',            async (req, res) => {
            res.status(501).json({
                success: false,
                message: 'Удаление аккаунта ещё не подключено к API (нужна хранимка + SMS)'
            });
        });

        this.app.post('/api/auth/confirm-delete',              async (req, res) => {
            res.status(501).json({
                success: false,
                message: 'Удаление аккаунта ещё не подключено к API (нужна хранимка + SMS)'
            });
        });

        this.app.get('/api/privacy',                                 (req, res) => {
            res.send(`
                <!DOCTYPE html>
                <html lang="ru">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Политика конфиденциальности — GruzReis</title>
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
                        h1 { color: #2c3e50; border-bottom: 2px solid #eee; padding-bottom: 10px; }
                        h2 { color: #34495e; margin-top: 30px; }
                        p { margin-bottom: 15px; }
                        .date { color: #7f8c8d; font-style: italic; }
                    </style>
                </head>
                <body>
                    <h1>Политика конфиденциальности</h1>
                    <p class="date">Последнее обновление: 14 апреля 2026 г.</p>
                    <p>...</p>
                </body>
                </html>
            `);
        });

        this.app.get('/api/deleteAccount',                           (req, res) => {
            res.send(`
                <!DOCTYPE html>
                <html lang="ru">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Удаление аккаунта — GruzReis</title>
                    <style>
                        body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f4f7f6; }
                        .card { background: white; padding: 30px; border-radius: 12px; max-width: 400px; width: 100%; text-align: center; }
                        h1 { color: #e74c3c; font-size: 22px; }
                        p { color: #666; font-size: 14px; margin-bottom: 20px; }
                        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; font-size: 16px; }
                        button { width: 100%; padding: 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 16px; }
                        .btn-code { background-color: #3498db; color: white; }
                        .btn-delete { background-color: #e74c3c; color: white; display: none; }
                        .status-msg { margin-top: 15px; font-size: 13px; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>Удаление аккаунта</h1>
                        <p>Все ваши данные, включая историю рейсов и профиль, будут безвозвратно удалены.</p>
                        <input type="tel" id="phone" placeholder="+7 (999) 000-00-00">
                        <button id="sendBtn" class="btn-code" onclick="sendSms()">Получить код в СМС</button>
                        <div id="codeSection" style="display:none;">
                            <input type="text" id="code" placeholder="Код из СМС">
                            <button class="btn-delete" id="deleteBtn" onclick="confirmDelete()">Подтвердить удаление</button>
                        </div>
                        <div id="status" class="status-msg"></div>
                    </div>
                    <script>
                        async function sendSms() {
                            const phone = document.getElementById('phone').value;
                            if(!phone) return alert('Введите номер телефона');
                            const res = await fetch('/api/auth/send-delete-code', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ phone })
                            });
                            const data = await res.json().catch(() => ({}));
                            if(res.ok) {
                                document.getElementById('codeSection').style.display = 'block';
                                document.getElementById('deleteBtn').style.display = 'block';
                                document.getElementById('sendBtn').innerText = 'Отправить код повторно';
                                document.getElementById('status').innerText = 'Код отправлен на ваш номер';
                                document.getElementById('status').style.color = 'green';
                            } else {
                                alert(data.message || 'Ошибка при отправке СМС. Проверьте номер.');
                            }
                        }
                        async function confirmDelete() {
                            const phone = document.getElementById('phone').value;
                            const code = document.getElementById('code').value;
                            if(!code) return alert('Введите код');
                            if(confirm('Вы уверены? Это действие нельзя отменить.')) {
                                const res = await fetch('/api/auth/confirm-delete', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ phone, code })
                                });
                                const data = await res.json().catch(() => ({}));
                                if(res.ok) {
                                    document.body.innerHTML = '<div class="card"><h1>Аккаунт удален</h1><p>Ваши данные успешно стерты из системы GruzReis.</p></div>';
                                } else {
                                    alert(data.message || 'Неверный код или ошибка сервера.');
                                }
                            }
                        }
                    </script>
                </body>
                </html>
            `);
        });
    }

    setupSocketIO() {
        this.io = socketIo(this.server, {
            ...SOCKET_CONFIG,
            cors: {
                origin: this.createCorsOriginChecker('Socket.IO'),
                methods: ['GET', 'POST'],
                credentials: true,
                allowedHeaders: ['Content-Type', 'Authorization']
            },
            transports: SOCKET_CONFIG.transports || ['websocket', 'polling'],
            allowEIO3: true
        });

        this.socketHandlers = new SocketHandlers(this.io);

        this.io.on('connection', (socket) => {
            if (process.env.LOG_HTTP === '1') {
                console.log(`Socket.IO подключен: ${socket.id}`);
            }
            this.socketHandlers.handleConnection(socket);
        });

        console.log('✅ Socket.IO настроен с CORS и SOCKET_CONFIG');
    }

    setupErrorHandling() {
        this.app.use((error, req, res, next) => {
            console.error('❌ Express error:', error.message);
            if (res.headersSent) return next(error);
            res.status(error.message === 'Not allowed by CORS' ? 403 : 500).json({
                success: false,
                message: error.message || 'Внутренняя ошибка сервера'
            });
        });

        process.on('unhandledRejection', (reason) => {
            console.error('❌ Необработанное отклонение промиса:', reason);
        });

        process.on('uncaughtException', (error) => {
            console.error('❌ Необработанное исключение:', error);
            this.gracefulShutdown();
        });

        process.on('SIGTERM', () => this.gracefulShutdown());
        process.on('SIGINT', () => this.gracefulShutdown());
    }

    async gracefulShutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        console.log('🔄 Начинаем graceful shutdown...');

        const closeHttp = () => new Promise((resolve) => {
            this.server.close(() => {
                console.log('✅ HTTP сервер закрыт');
                resolve();
            });
        });

        const closeIo = () => new Promise((resolve) => {
            if (!this.io) return resolve();
            this.io.close(() => {
                console.log('✅ Socket.IO сервер закрыт');
                resolve();
            });
        });

        try {
            await Promise.race([
                Promise.all([closeHttp(), closeIo(), closePool()]),
                new Promise((resolve) => setTimeout(resolve, 8000))
            ]);
            console.log('✅ Graceful shutdown завершен');
            process.exit(0);
        } catch (error) {
            console.error('❌ Ошибка shutdown:', error);
            process.exit(1);
        }
    }

    start() {
        
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
            console.warn('⚠️ SMTP_USER/SMTP_PASS не заданы — /api/sendEmail будет недоступен');
        }

        if (!process.env.GEMINI_API_KEY) {
            console.warn('⚠️ GEMINI_API_KEY не задан — проверка паспорта будет недоступна');
        }

        this.server.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Сервер запущен на порту ${PORT}`);
            console.log(`📡 Адрес: http://0.0.0.0:${PORT}`);
            console.log(`📊 Статус: http://localhost:${PORT}/api/status`);
        });
    }
}

const app = new App();
app.start();
