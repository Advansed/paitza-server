require('dotenv').config();
const express                   = require('express');
const http                      = require('http');
const socketIo                  = require('socket.io');
const cors                      = require('cors');
const { SOCKET_CONFIG, PORT }   = require('./config');
const SocketHandlers            = require('./socketHandlers');
const nodemailer                = require('nodemailer');
const bodyParser                = require('body-parser');
const { S3Client }              = require("@aws-sdk/client-s3");
const { PutObjectCommand }      = require("@aws-sdk/client-s3");
const { getSignedUrl }          = require("@aws-sdk/s3-request-presigner");
const { UNSIGNED_PAYLOAD }      = require("@aws-sdk/signature-v4");

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
    region:                     process.env.YC_REGION || "ru-central1",
    endpoint:                   "https://storage.yandexcloud.net",
    credentials: {
        accessKeyId:            process.env.YC_ACCESS_KEY_ID,
        secretAccessKey:        process.env.YC_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: "WHEN_REQUIRED", 
    responseChecksumValidation: "WHEN_REQUIRED",
    signatureVersion: 'v4'
});

module.exports = s3Client;

const transporter = nodemailer.createTransport({
    host:       'smtp.mail.ru',
    port:       465,
    secure:     true,
    auth: {
        user:     'gvr_no_reply@bk.ru',
        pass:     'a5ajTkBvQfYmZzmAvDa9'
    }
});

class App {
    
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = null;
        this.socketHandlers = null; // Инициализируем null

        this.setupCORS();
        
        this.app.use(bodyParser.json({ limit: '50mb' }));
        this.app.use(bodyParser.urlencoded({
            extended: true,
            limit: '50mb',
            parameterLimit: 50000
        }));

        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketIO();   // Здесь создаются io и socketHandlers
        this.setupErrorHandling();
    }

    setupCORS() {
        const allowedOrigins = this.getAllowedOrigins();

        const corsOptions = {
            origin: function (origin, callback) {
                if (!origin) return callback(null, true);
                if (allowedOrigins.indexOf(origin) !== -1 ||
                    origin.startsWith('file://') ||
                    origin.startsWith('ionic://') ||
                    origin.startsWith('capacitor://')) {
                    callback(null, true);
                } else {
                    console.log('❌ Заблокирован CORS для origin:', origin);
                    callback(null, true);
                }
            },
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
        console.log('📋 Разрешенные origins:', allowedOrigins);
    }

    getAllowedOrigins() {
        const origins = [
            'http://localhost:3000',
            'http://localhost:3001', 
            'http://localhost:8080',
            'http://localhost:8100',
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
            'http://10.30.20.30:8100',
            'https://paitza.com', 
            'https://paitza.com',
            'capacitor://localhost',
            'ionic://localhost',
            'file://'
        ];
        
        if (process.env.CORS_ORIGIN) {
            process.env.CORS_ORIGIN.split(',').forEach(origin => {
                if (!origins.includes(origin)) {
                    origins.push(origin);
                }
            });
        }
        
        return origins;
    }

    setupMiddleware() {
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
        
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
            console.log(`📱 Origin: ${req.headers.origin || 'нет'}`);
            console.log(`📱 User-Agent: ${req.headers['user-agent'] || 'нет'}`);
            next();
        });
    }

    setupRoutes() {
        this.app.get('/api/status', async (req, res) => {
            res.json({
                status: 'running',
                connections: this.io ? this.io.engine.clientsCount : 0,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
                cors: 'enabled',
                allowedOrigins: this.getAllowedOrigins()
            });
        });

        this.app.get('/api/getVersion', async (req, res) => {
            res.json({ success: true, data: "1.0.1" });
        });

        this.app.post('/api/sendimage', async (req, res) => {
            try {
                const { token, recipient, cargo, image } = req.body;
                const result = await this.socketHandlers.handleMethod(
                    { emit: () => {} },
                    'send_image', 
                    { token, recipient, cargo, image, message: "" }
                );
                res.json(result);
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/set_location', async (req, res) => {
            try {
                const { token, recipient, cargo, image } = req.body;
                const result = await this.socketHandlers.handleMethod(
                    { emit: () => {} },
                    'set_location', 
                    { token, recipient, cargo, image, message: "" }
                );
                res.json(result);
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/sendEmail', async (req, res) => {
            try {
                const { token, email, pdf } = req.body;
                console.log("send_email", email);
                console.log("pdf", pdf ? pdf.substring(0, 64) : 'нет');

                const mailOptions = {
                    from: 'gvr_no_reply@bk.ru',
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
                      console.error('Ошибка:', error);
                      res.json({ success: false, message: error.message });
                    } else {
                      console.log(info);
                      console.log('Письмо отправлено:', info.response);
                      res.json({ success: true, message: "Письмо отправлено" });
                    }
                });
                
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/company', async (req, res) => {
            try {
                const data = req.body;
                const result = await this.socketHandlers.handleMethod(
                    { emit: () => {} },
                    'upd_company', 
                    data
                );
                res.json(result);                                
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/kassa', async (req, res) => {
            try {
                const data = req.body;
                const result = await this.socketHandlers.handleMethod(
                    { emit: () => {} },
                    'upd_kassa', 
                    data
                );
                res.json(result);                                
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/cargos', async (req, res) => {
            try {
                const data = req.body;
                console.log("data", req.body);
                const result = await this.socketHandlers.handleMethod(
                    { emit: () => {} },
                    'upd_cargo', 
                    data
                );
                res.json(result);                                
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/deals', async (req, res) => {
            try {
                const data = req.body;
                const result = await this.socketHandlers.handleMethod(
                    { emit: () => {} },
                    'upd_deals', 
                    data
                );
                res.json(result);                                
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/deal_details', async (req, res) => {
            try {
                const data = req.body;
                const result = await this.socketHandlers.handleMethod(
                    { emit: () => {} },
                    'upd_deal_details', 
                    data
                );
                res.json(result);                                
            } catch (error) {
                res.json({ success: false, message: error.message });
            }
        });

        this.app.post('/api/tinkoff_payment', (req, res) => {
            console.log('Tinkoff callback:', req.body);
            res.json({ success: true });
        });

        this.app.get('/api/get_token', async (req, res) => {
            console.log('Tinkoff callback:', req.query);
            try{
                const result = await this.socketHandlers.checkToken( req.query )
                res.json({ success: true, data: result });
            } catch (error) {
                res.json({success: false, message: error.message })
            }
        });

        this.app.get('/api/getUrl', async (req, res) => {
            const result = await this.socketHandlers.checkToken(req.query);
        
            if (result) {
                const fileName = `${req.query.cargo_id}/${result.id}/${req.query.recipient_id}/${req.query.filename}`;
                const bucketName = 'chat-fotos'; 
        
                try {
                    const command = new PutObjectCommand({
                        Bucket:                 bucketName,
                        Key:                    fileName,
                        ContentType:            '',
                        ChecksumAlgorithm:      undefined
                    });
        
                    const presignedUrl = await getSignedUrl(s3Client, command, { 
                        expiresIn: 60,
                        signableHeaders: new Set(['host']),
                    });
        
                    res.json({
                        uploadUrl: presignedUrl,
                        filePath: fileName,
                        publicUrl: `https://storage.yandexcloud.net/${bucketName}/${fileName}`
                    });
                } catch (error) {
                    res.status(500).json({ error: error.message });
                }
            } else res.status(401).json({ error: "Неверный токен" });
        });

        this.app.get('/api/get_VKUrl', async (req, res) => {
            const { filename } = req.query;
            try {
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
                console.error('❌ Ошибка:', error);
                res.status(500).json({ error: true, message: error.message });
            }
        });

        this.app.get('/api/privacy', (req, res) => {
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

        this.app.get('/api/deleteAccount', (req, res) => {
            res.send(`
                <!DOCTYPE html>
                <html lang="ru">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Удаление аккаунта — GruzReis</title>
                    <style>
                        body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f4f7f6; }
                        .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); max-width: 400px; width: 100%; text-align: center; }
                        h1 { color: #e74c3c; font-size: 22px; }
                        p { color: #666; font-size: 14px; margin-bottom: 20px; }
                        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; font-size: 16px; }
                        button { width: 100%; padding: 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 16px; transition: 0.3s; }
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
                            if(res.ok) {
                                document.getElementById('codeSection').style.display = 'block';
                                document.getElementById('deleteBtn').style.display = 'block';
                                document.getElementById('sendBtn').innerText = 'Отправить код повторно';
                                document.getElementById('status').innerText = 'Код отправлен на ваш номер';
                                document.getElementById('status').style.color = 'green';
                            } else {
                                alert('Ошибка при отправке СМС. Проверьте номер.');
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
                                if(res.ok) {
                                    document.body.innerHTML = '<div class="card"><h1>Аккаунт удален</h1><p>Ваши данные успешно стерты из системы GruzReis.</p></div>';
                                } else {
                                    alert('Неверный код или ошибка сервера.');
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
        const allowedOrigins = this.getAllowedOrigins();

        // Создаём io
        this.io = socketIo(this.server, {
            cors: {
                origin: function (origin, callback) {
                    if (!origin) return callback(null, true);
                    if (allowedOrigins.indexOf(origin) !== -1 ||
                        origin.startsWith('file://') ||
                        origin.startsWith('ionic://') ||
                        origin.startsWith('capacitor://')) {
                        callback(null, true);
                    } else {
                        console.log('❌ Socket.IO заблокирован origin:', origin);
                        callback(null, true);
                    }
                },
                methods: ['GET', 'POST'],
                credentials: true,
                allowedHeaders: ['Content-Type', 'Authorization']
            },
            transports: ['websocket', 'polling'],
            allowEIO3: true
        });

        // Создаём socketHandlers, передавая io
        this.socketHandlers = new SocketHandlers(this.io);

        this.io.on('connection', (socket) => {
            console.log(`🔌 Socket.IO подключен: ${socket.id}`);
            console.log(`📱 Socket Origin: ${socket.handshake.headers.origin || 'нет'}`);
            this.socketHandlers.handleConnection(socket);
        });

        console.log('✅ Socket.IO настроен с CORS');
    }

    setupErrorHandling() {
        process.on('unhandledRejection', (reason, promise) => {
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
        console.log('🔄 Начинаем graceful shutdown...');
        
        this.server.close(() => {
            console.log('✅ HTTP сервер закрыт');
        });
        
        if (this.io) {
            this.io.close(() => {
                console.log('✅ Socket.IO сервер закрыт');
            });
        }
        
        console.log('✅ Graceful shutdown завершен');
        process.exit(0);
    }

    start() {
        this.server.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Сервер запущен на порту ${PORT}`);
            console.log(`📡 Адрес: http://0.0.0.0:${PORT}`);
            console.log(`📊 Статус: http://localhost:${PORT}/api/status`);
            console.log(`🔒 CORS включен (только для /api)`);
        });
    }
}

const app = new App();
app.start();