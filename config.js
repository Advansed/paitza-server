const sql = require('mssql');
const Anthropic = require('@anthropic-ai/sdk');

// База данных
const sqlConfig = {
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'cargos',
    server: process.env.DB_SERVER || 'localhost',
    pool: {
        max: 10,
        min: 2,
        idleTimeoutMillis: 30000,
        acquireTimeoutMillis: 60000
    },
    options: {
        encrypt: true,
        trustServerCertificate: true,
        enableArithAbort: true,
        requestTimeout: 30000
    }
};

// AI (Claude)
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// Платежи Tinkoff
const TINKOFF_CONFIG = {
    terminalKey:    process.env.TINKOFF_KEY,
    password:       process.env.TINKOFF_PASS,
    baseURL:        'https://securepay.tinkoff.ru/v2/'
};

// SMS
const SMS_CONFIG = {
    apiId: process.env.SMS_API_KEY,
    host: 'sms.ru'
};

// Socket.IO
const SOCKET_CONFIG = {
    transports:         ['websocket', 'polling'],
    maxHttpBufferSize:  1e8,                 // например, 100 МБ
    pingTimeout:        60000,               // 60 секунд
    pingInterval:       25000                // 25 секунд
};


module.exports = {
    sqlConfig,
    anthropic,
    TINKOFF_CONFIG,
    SMS_CONFIG,
    SOCKET_CONFIG,
    PORT: process.env.PORT || 3000
};