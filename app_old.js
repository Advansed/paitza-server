require('dotenv').config();
const express        = require('express');
const http           = require('http');
const socketIo       = require('socket.io');
const cors           = require('cors');
const { SOCKET_CONFIG, PORT } = require('./config');
const SocketHandlers = require('./socketHandlers');
const nodemailer     = require('nodemailer');
const bodyParser     = require('body-parser');

const transporter = nodemailer.createTransport({
  host:   'smtp.mail.ru',
  port:   465,
  secure: true,
  auth: {
    user: 'gvr_no_reply@bk.ru',
    pass: 'a5ajTkBvQfYmZzmAvDa9'
  }
});

class App {
  constructor() {
    this.app    = express();
    this.server = http.createServer(this.app);

    this.setupCORS();
    this.app.use(bodyParser.json({ limit: '50mb' }));
    this.app.use(bodyParser.urlencoded({
      extended: true,
      limit: '50mb',
      parameterLimit: 50000
    }));

    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketIO();
    this.setupErrorHandling();
  }

  setupCORS() {
    const defaultOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:8080',
      'http://localhost:8100',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:8080',
      'http://127.0.0.1:8100',
      'http://localhost:5000',
      'http://127.0.0.1:5000',
      'https://gruzreis.ru',
      'https://grusvreis.ru'
    ];

    const originsFromEnv = process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
      : [];

    const allowedOrigins = originsFromEnv.length ? originsFromEnv : defaultOrigins;

    const corsOptions = {
      origin: allowedOrigins,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
      credentials: true,
      optionsSuccessStatus: 200,
      preflightContinue: false,
      maxAge: 86400
    };

    this.app.use(cors(corsOptions));
    this.app.options('*', cors(corsOptions));

    console.log('CORS origins (Express):', allowedOrigins);
  }

  setupMiddleware() {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - Origin: ${req.headers.origin || 'нет'}`);
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
        cors: 'enabled'
      });
    });

    this.app.get('/api/getVersion', async (req, res) => {
      res.json({
        success: true,
        data: '1.0.1'
      });
    });

    this.app.post('/api/sendimage', async (req, res) => {
      try {
        const { token, recipient, cargo, image } = req.body;
        const result = await this.socketHandlers.handleMethod(
          { emit: () => {} },
          'send_image',
          { token, recipient, cargo, image, message: '' }
        );
        res.json(result);
      } catch (error) {
        res.json({ success: false, message: error.message });
      }
    });

    this.app.post('/api/sendEmail', async (req, res) => {
      try {
        const { token, email, pdf } = req.body;

        console.log('send_email', email);
        console.log('pdf', pdf.substring(0, 64));

        const mailOptions = {
          from:    'gvr_no_reply@bk.ru',
          to:      email,
          subject: 'Счет на оплатьу',
          text:    'См. вложение.',
          attachments: [
            {
              filename:    'invoice.pdf',
              content:     pdf,
              encoding:    'base64',
              contentType: 'application/pdf',
              disposition: 'attachment'
            }
          ]
        };

        console.log('send', mailOptions.to);
        transporter.sendMail(mailOptions, (error, info) => {
          if (error) {
            console.error('Ошибка:', error);
            res.json({ success: false, message: error.message });
          } else {
            console.log(info);
            console.log('Письмо отправлено:', info.response);
            res.json({ success: true, message: 'Письмо отправлено' });
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
        console.log('data', req.body);
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
  }

  setupSocketIO() {
    const defaultOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:8080',
      'http://localhost:8100',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:8080',
      'http://127.0.0.1:8100',
      'https://gruzreis.ru',
      'https://grusvreis.ru'
    ];

    const originsFromEnv = process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
      : [];

    const allowedOrigins = originsFromEnv.length ? originsFromEnv : defaultOrigins;

    this.io = socketIo(this.server, {
      ...SOCKET_CONFIG,
      cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization']
      }
    });

    console.log('CORS origins (Socket.IO):', allowedOrigins);

    this.socketHandlers = new SocketHandlers(this.io);

    this.io.on('connection', (socket) => {
      console.log(`🔌 Socket.IO подключен: ${socket.id}`);
      this.socketHandlers.handleConnection(socket);
    });
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
    this.server.listen(PORT, () => {
      console.log(`🚀 Socket.IO сервер запущен на порту ${PORT}`);
      console.log(`📊 Статус сервера: http://localhost:${PORT}/api/status`);
      console.log(`🔒 CORS origins: ${process.env.CORS_ORIGIN || 'используются значения по умолчанию'}`);
    });
  }
}

const appInstance = new App();
appInstance.start();
