const sql = require('mssql');
const axios = require('axios');
const crypto = require('crypto');
const { sqlConfig, TINKOFF_CONFIG, anthropic } = require('./config');

// База данных
let globalPool = null;
let isPoolConnecting = false;

class DatabaseService {
    async initializePool() {
        if (globalPool) return globalPool;
        if (isPoolConnecting) {
            while (isPoolConnecting) await new Promise(resolve => setTimeout(resolve, 100));
            return globalPool;
        }

        try {
            isPoolConnecting = true;
            console.log('Инициализация пула соединений с базой данных...');
            
            globalPool = new sql.ConnectionPool(sqlConfig);
            
            globalPool.on('connect', () => console.log('✅ Пул соединений подключен'));
            globalPool.on('close', () => { globalPool = null; });
            globalPool.on('error', (err) => { 
                console.error('❌ Ошибка пула:', err);
                globalPool = null;
            });

            await globalPool.connect();
            console.log('✅ Пул соединений успешно инициализирован');
            return globalPool;
            
        } catch (error) {
            console.error('❌ Ошибка инициализации пула:', error);
            globalPool = null;
            throw error;
        } finally {
            isPoolConnecting = false;
        }
    }

    async getPool() {
        if (!globalPool || !globalPool.connected) {
            return await this.initializePool();
        }
        return globalPool;
    }

    async executeProcedure(path, params) {
        try {
            
            const pool = await this.getPool();
            const request = pool.request();
            request.input('json', JSON.stringify(params));
            
            const result = await request.execute(`p_${path}`);
            
            if (result.recordset && result.recordset.length > 0) {
                const record = result.recordset[0];
                if (record.data !== undefined) {
                    return typeof record.data === 'string' ? JSON.parse(record.data) : record.data;
                }
            }
            
            throw new Error("Данные не найдены");
            
        } catch (error) {
            console.error(`❌ Ошибка выполнения p_${path}:`, error);
            throw error;
        }
    }
    
    async getToken(params) {
        try {
            console.log('Выполнение запроса: getToken');
            console.log('Параметры:', JSON.stringify(params, null, 2));
            
            const pool = await this.getPool();
            const request = pool.request();
            
            // Добавляем входной параметр
            request.input('token', sql.NVarChar, params.token); // желательно указать тип
            
            // Выполняем прямой SQL-запрос
            const result = await request.query('SELECT id, code, name, email, user_type FROM t_users WHERE token = @token');
            
            console.log('Результат запроса:', result);
            
            if (result.recordset && result.recordset.length > 0) {
                // Возвращаем найденную запись (например, { id: ... })
                return result.recordset[0];
            } else {
                // Пользователь не найден
                return null;
            }
        } catch (error) {
            console.error('Ошибка при выполнении getToken:', error);
            throw error; // или вернуть объект с ошибкой, в зависимости от архитектуры
        }
    }
}

// Платежи Tinkoff
class TinkoffPaymentService {
    constructor() {
        this.config = TINKOFF_CONFIG;
    }

    createToken(requestData) {
        const data = { ...requestData };
        if (data.Token) delete data.Token;
        
        const sortedKeys = Object.keys(data).sort();
        const values = sortedKeys.map(key => data[key]);
        const concatenated = values.join('');
        console.log(concatenated)
        return crypto.createHash('sha256')
            .update(concatenated, 'utf8')
            .digest('hex');
    }

    async createSBPPayment(orderData) {
        const requestData = {
            TerminalKey: this.config.terminalKey,
            Amount: orderData.amount,
            OrderId: orderData.orderId,
            Description: orderData.description,
            SuccessURL: orderData.success_url,
            FailURL: orderData.fail_url,
            NotificationURL: orderData.callback_url,
            PayType: 'O',
            RedirectDueDate: orderData.RedirectDueDate,
            DATA: {
                Email: orderData.email,
                Phone: orderData.phone,
                QrCode: 'QRCode',
                PaymentMethod: 'sbp'
            },
            Receipt: orderData.receipt
        };

        requestData.Token = this.createToken({
            Amount:             requestData.Amount,
            Description:        requestData.Description,
            FailURL:            requestData.FailURL,
            NotificationURL:    requestData.NotificationURL,
            OrderId:            requestData.OrderId,
            SuccessURL:         requestData.SuccessURL,
            PayType:            requestData.PayType,
            Password:           this.config.password,
            RedirectDueDate:    requestData.RedirectDueDate,
            TerminalKey:        this.config.terminalKey
        });

        console.log(requestData)
        try {
            const response = await axios.post(`${this.config.baseURL}Init`, requestData);
            console.log('init', response.data)
            if (response.data.Success) {
                // Получаем QR-код
                const qrResult = await this.getQrCode(response.data.PaymentId);
                console.log('getQR', qrResult)
                return {
                    success: true,
                    payment_id: response.data.PaymentId,
                    payment_url: response.data.PaymentURL,
                    order_id: response.data.OrderId,
                    status: response.data.Status,
                    ...qrResult
                };
            } else {
                return {
                    success: false,
                    message: response.data.Message,
                    error_code: response.data.ErrorCode
                };
            }
        } catch (error) {
            console.error('❌ Tinkoff SBP payment error:', error);
            return { success: false, error: error.message };
        }
    }

    async getQrCode(paymentId) {
        const requestData = {
            TerminalKey:    this.config.terminalKey,
            PaymentId:      paymentId,
            DataType:       'PAYLOAD'
        };

        requestData.Token = this.createToken({
            DataType:       requestData.DataType,
            Password:       this.config.password,
            PaymentId:      requestData.PaymentId,
            TerminalKey:    requestData.TerminalKey,
        });

        try {
            console.log("параметры getQR", requestData)
            const response = await axios.post(`${this.config.baseURL}GetQr`, requestData);
            console.log('GetQr', response.data )
            
            if (response.data.Success) {
                return {
                    qr_url: response.data.QrCodeUrl,
                    sbp_payload: response.data.Data,
                    sbp_deep_link: `https://qr.nspk.ru/${response.data.Data}`
                };
            }
            
            return { qr_url: null, sbp_payload: null, sbp_deep_link: null };
        } catch (error) {
            console.error('❌ Tinkoff GetQr error:', error);
            return { qr_url: null, sbp_payload: null, sbp_deep_link: null };
        }
    }

    
    async checkPaymentStatus(paymentId) {
        try {
            const token = this.createToken({
                TerminalKey:    this.config.terminalKey,
                PaymentId:      paymentId,
                Password:       this.config.password
            });
            
            console.log("axios", {
                TerminalKey:    this.config.terminalKey,
                PaymentId:      paymentId,
                Token:          token
            })

            const response = await axios.post(`${this.config.baseURL}GetState`, {
                TerminalKey:    this.config.terminalKey,
                PaymentId:      paymentId,
                Token:          token
            }, {
                timeout: 10000, // таймаут 10 секунд
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.data.Success) {
                console.log(`[${new Date().toISOString()}] Payment ${paymentId}: ${response.data.Status}`);
                return response.data;
            } else {
                console.error(`Ошибка API: ${response.data.ErrorCode} - ${response.data.Message}`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Ошибка запроса:`, error.message);
        }
    }

}

// AI Сервис
class AIService {
    async sendMessage(messages, systemMessage = "Ты - ИИ-помощник для логистической платформы грузоперевозок.") {
        try {
            const response = await anthropic.messages.create({
                model: 'claude-opus-4-1-20250805',
                max_tokens: 1500,
                temperature: 0.7,
                system: systemMessage,
                messages: messages
            });

            return {
                success: true,
                message: response.content[0].text,
                usage: response.usage,
                timestamp: new Date()
            };
        } catch (error) {
            console.error('❌ Ошибка Claude API:', error);
            return {
                success: false,
                message: 'Ошибка при обработке запроса к AI',
                error: error.message
            };
        }
    }

    async analyzeCargo(cargo, action) {
        let prompt = '';
        
        switch(action) {
            case 'optimize_route':
                prompt = `Проанализируй маршрут доставки груза и предложи оптимизацию:
                    От: ${cargo.address}
                    До: ${cargo.destiny}
                    Груз: ${cargo.name}
                    Вес: ${cargo.weight} кг
                    Объем: ${cargo.volume} м³`;
                break;
                
            case 'calculate_price':
                prompt = `Рассчитай рекомендуемую стоимость перевозки:
                    От: ${cargo.address}
                    До: ${cargo.destiny}
                    Вес: ${cargo.weight} кг`;
                break;
        }

        return await this.sendMessage([{ role: 'user', content: prompt }]);
    }
}

// Утилиты
class SocketManager {
    constructor() {
        this.socketsByUserType = new Map();
        this.socketsByUserId = new Map();
    }

    registerSocket(socket, userData) {
        if (userData.id && userData.user_type) {
            socket.userId = userData.id;
            socket.userName = userData.name;
            socket.userToken = userData.token;
            socket.user_type = userData.user_type;

            this.socketsByUserId.set(userData.id, socket);
            
            if (!this.socketsByUserType.has(userData.user_type)) {
                this.socketsByUserType.set(userData.user_type, new Set());
            }
            this.socketsByUserType.get(userData.user_type).add(socket);
        }
    }

    unregisterSocket(socket) {
        if (socket.userId) {
            this.socketsByUserId.delete(socket.userId);
        }
        
        if (socket.user_type && this.socketsByUserType.has(socket.user_type)) {
            this.socketsByUserType.get(socket.user_type).delete(socket);
        }
    }

    findSocket(userId) {
        return this.socketsByUserId.get(userId) || null;
    }

    broadcastToUserType(userType, event, data) {
        const sockets = this.socketsByUserType.get(userType);
        if (sockets) {
            sockets.forEach(socket => {
                socket.emit(event, data);
            });
        }
    }
}

module.exports = {
    DatabaseService,
    TinkoffPaymentService,
    AIService,
    SocketManager
};