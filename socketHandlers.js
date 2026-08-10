const axios                         = require('axios');
const puppeteer                     = require('puppeteer');
const fs                            = require('fs');
const path                          = require('path');
const { DatabaseService, TinkoffPaymentService, AIService, SocketManager } 
                                    = require('./services');
const PassportVerificationService   = require('./passportVerification');
const { uploadFotos, decodeBase64File, getFotosBuffer, resolveImageInput } = require('./storage');

const GATEWAY_URL = 'https://gatewayapi.telegram.org/';

const gatewayHeaders = {
    'Authorization': `Bearer ${process.env.TELEGRAM_KEY}`,
    'Content-Type': 'application/json'
};

const sendSMS                                   = async (to, msg) => {
    const apiId = process.env.SMS_API_KEY;

    // 1. Ранний выход, если нет ключа
    if (!apiId) {
        throw new Error("SMS_API_KEY отсутствует в переменных окружения.");
    }

    const baseUrl = 'https://sms.ru/sms/send';

    try {
        const response = await axios.get(baseUrl, {
            params: {
                api_id:     apiId,
                to:         to,
                msg:        msg,
                json:       1
            }
        });

        const data = response.data;

        // 2. Логика SMS.ru: они возвращают 200 OK даже при внутренних ошибках, 
        // поэтому проверяем поле status в JSON
        if (data.status === 'OK') {
            return data;
        } else {
            // Выбрасываем ошибку с текстом и кодом от самого сервиса
            throw new Error(`SMS.ru Error: ${data.status_text} (Код: ${data.status_code})`);
        }
    } catch (err) {
        // 3. Улучшенная обработка ошибок
        if (err.response) {
            // Ошибка пришла от сервера (статус 4xx, 5xx)
            throw new Error(`Server Error: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
        } else if (err.request) {
            // Запрос был сделан, но ответ не получен (проблемы с сетью)
            throw new Error("Network Error: Сервер SMS.ru не отвечает.");
        } else {
            // Что-то пошло не так при настройке запроса
            throw new Error(err.message);
        }
    }
}


const sendGatewayVerification                   = async (phoneNumber) => {
    try {
        // Очищаем номер: оставляем только цифры
        const cleanPhone = phoneNumber.replace(/\D/g, '');

        // Убедись, что GATEWAY_URL не имеет лишнего слеша в конце
        const url = `${GATEWAY_URL.replace(/\/$/, '')}/sendVerificationMessage`;

        console.log( url, cleanPhone )

        const response = await axios.post(url, {
            phone_number: cleanPhone,
            code_length: 4,
            ttl: 120
        }, { headers: gatewayHeaders });

        const { data } = response;

        // Проверяем флаг 'ok' от Telegram
        if (data.ok && data.result) {
            return { 
                success: true, 
                request_id: data.result.request_id 
            };
        } else {
            throw new Error(data.error || 'Неизвестная ошибка API');
        }

    } catch (error) {
        console.log("gateway", error)
        const errorMsg = error.response?.data?.description || error.message;
        console.error('Gateway Send Error:', errorMsg);
        return { success: false, message: errorMsg };
    }
}


const checkGatewayCode                          = async ( requestId, code ) => {
    try {
        // Убираем лишние слеши из URL
        const url = `${GATEWAY_URL.replace(/\/$/, '')}/checkVerificationStatus`;

        const response = await axios.post(url, {
            request_id: requestId,
            code: code
        }, { headers: gatewayHeaders });

        const { data } = response;

        // 1. Проверяем, что сам запрос прошел успешно (ok: true)
        if (data.ok && data.result?.verification_status) {
            const vStatus = data.result.verification_status.status;

            // 2. Проверяем конкретный статус кода
            switch (vStatus) {
                case "code_valid":
                    return { success: true, message: "Номер подтвержден!" };
                case "code_invalid":
                    return { success: false, message: "Неверный код. Попробуйте еще раз." };
                case "expired":
                    return { success: false, message: "Время жизни кода истекло." };
                case "too_many_attempts":
                    return { success: false, message: "Слишком много попыток. Номер временно заблокирован." };
                default:
                    return { success: false, message: `Статус проверки: ${vStatus}` };
            }
        } else {
            // Ошибка самого API (например, неверный requestId)
            return { 
                success: false, 
                message: data.description || "Ошибка верификации на стороне сервера" 
            };
        }

    } catch (error) {
        // Вытаскиваем детальное описание ошибки от Telegram, если оно есть
        const errorDetail = error.response?.data?.description || error.message;
        console.error('Gateway Check Error:', errorDetail);
        
        return { success: false, error: errorDetail };
    }
}


const toPDF                                     = async (htmlString) => {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(htmlString, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4' });
    await browser.close();
    // Возвращает строку
    const str = (Buffer.from(pdfBuffer)).toString('base64');
    return str
}


const fillTemplate                              = (template, data) => {
    let result = template;
    
    // Замена основных параметров
    result = result.replace(/ORDER_NUMBER/g, data.document_info.order_number);
    result = result.replace(/CITY/g, data.document_info.city);
    result = result.replace(/DAY/g, data.document_info.day);
    result = result.replace(/MONTH/g, data.document_info.month);
    result = result.replace(/YEAR/g, data.document_info.year);
    
    // Замена данных заказчика
    result = result.replace(/CUSTOMER_NAME/g, data.customer.name);
    result = result.replace(/CUSTOMER_GENDER_SUFFIX/g, data.customer.gender_suffix);
    result = result.replace(/CUSTOMER_REPRESENTATIVE_GENDER_SUFFIX/g, data.customer.representative_gender_suffix);
    result = result.replace(/CUSTOMER_REPRESENTATIVE/g, data.customer.representative);
    result = result.replace(/CUSTOMER_BASIS/g, data.customer.basis);
    
    // Замена данных перевозчика
    result = result.replace(/CARRIER_NAME/g, data.carrier.name);
    result = result.replace(/CARRIER_GENDER_SUFFIX/g, data.carrier.gender_suffix);
    result = result.replace(/CARRIER_REPRESENTATIVE_GENDER_SUFFIX/g, data.carrier.representative_gender_suffix);
    result = result.replace(/CARRIER_REPRESENTATIVE/g, data.carrier.representative);
    result = result.replace(/CARRIER_BASIS/g, data.carrier.basis);
    
    // Замена платежной информации
    result = result.replace(/PAYMENT_AMOUNT/g, data.payment.amount);
    result = result.replace(/CONTRACT_DATE/g, data.contract_date);
    
    // Замена данных спецификации
    result = result.replace(/SENDER_DETAILS/g, data.specification.sender_details);
    result = result.replace(/CARRIER_DETAILS/g, data.specification.carrier_details);
    result = result.replace(/RECIPIENT_DETAILS/g, data.specification.recipient_details);
    result = result.replace(/CARGO_NAME/g, data.specification.cargo_name);
    result = result.replace(/CARGO_QUANTITY/g, data.specification.cargo_quantity);
    result = result.replace(/CARGO_DIMENSIONS/g, data.specification.cargo_dimensions);
    result = result.replace(/CARGO_PACKAGING/g, data.specification.cargo_packaging);
    result = result.replace(/SPECIAL_CONDITIONS/g, data.specification.special_conditions);
    result = result.replace(/LOADING_ADDRESS/g, data.specification.loading_address);
    result = result.replace(/LOADING_DATE_TIME/g, data.specification.loading_date_time);
    result = result.replace(/DESTINATION_ADDRESS/g, data.specification.destination_address);
    result = result.replace(/DELIVERY_TERMS/g, data.specification.delivery_terms);
    result = result.replace(/VEHICLE_DETAILS/g, data.specification.vehicle_details);
    result = result.replace(/DRIVER_DETAILS/g, data.specification.driver_details);
    
    return result;
}


const fillTemplate1                             = (html, params) => {
    if (!params || typeof params !== 'object') {
        return html;
    }

    // Функция для безопасного получения значения по пути
    function getValue(obj, path) {
        return path.split('.').reduce((current, key) => {
            return current && current[key] !== undefined ? current[key] : '';
        }, obj);
    }

    // Функция форматирования чисел (валюты)
    function formatCurrency(value) {
        if (value === undefined || value === null || value === '') return '0.00';
        const num = typeof value === 'number' ? value : parseFloat(value);
        if (isNaN(num)) return '0.00';
        return num.toLocaleString('ru-RU', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    // Функция форматирования даты
    function formatDate(dateString) {
        if (!dateString) return '';
        try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) return dateString;
            return date.toLocaleDateString('ru-RU');
        } catch (e) {
            return dateString;
        }
    }

    // Подготавливаем данные с форматированием согласно интерфейсам
    const preparedData = {
        // Основные поля счета
        invoiceNumber: params.invoiceNumber || '',
        invoiceDate: formatDate(params.invoiceDate),
        paymentPurpose: params.paymentPurpose || '',
        paymentDue: formatDate(params.paymentDue),
        signer: params.signer || '',
        
        // Форматированные суммы
        total: formatCurrency(params.total),
        vat: formatCurrency(params.vat),
        // Рассчитываем сумму без НДС
        subtotal: formatCurrency((params.total || 0) - (params.vat || 0)),
        
        // Рассчитываем процент НДС
        vatRate: params.vat && params.total && (params.total - params.vat) > 0 ? 
            Math.round((params.vat / (params.total - params.vat)) * 100) : 0,
        
        // Данные продавца (SellerData)
        seller: {
            name: params.seller?.name || '',
            address: params.seller?.address || '',
            inn: params.seller?.inn || '',
            kpp: params.seller?.kpp || '',
            ogrn: params.seller?.ogrn || '',
            account: params.seller?.account || '',
            bank: params.seller?.bank || '',
            bankInn: params.seller?.bankInn || '',
            bik: params.seller?.bik || '',
            korAccount: params.seller?.korAccount || '',
            bankAddress: params.seller?.bankAddress || ''
        },
        
        // Данные покупателя (CustomerData)
        customer: {
            name: params.customer?.name || '',
            address: params.customer?.address || '',
            inn: params.customer?.inn || ''
        },
        
        // Подготовленные позиции счета (InvoiceItem[])
        items: Array.isArray(params.items) ? params.items.map((item, index) => ({
            index: index + 1,
            item_name: item.item_name || '',
            qty: item.qty || 0,
            unit: item.unit || 'шт.',
            price: formatCurrency(item.price),
            // Используем total из item или рассчитываем
            total: formatCurrency(item.total || (item.price * (item.qty || 0)))
        })) : []
    };

    let result = html;

    // 1. Заменяем простые плейсхолдеры (прямые поля InvoiceData)
    const invoicePlaceholders = [
        'invoiceNumber', 'invoiceDate', 'total', 'vat', 'subtotal', 'vatRate',
        'paymentPurpose', 'paymentDue', 'signer'
    ];
    
    invoicePlaceholders.forEach(key => {
        const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'gi');
        result = result.replace(placeholder, preparedData[key]);
    });

    // 2. Заменяем плейсхолдеры продавца (seller)
    const sellerFields = [
        'name', 'address', 'inn', 'kpp', 'ogrn', 'account', 
        'bank', 'bankInn', 'bik', 'korAccount', 'bankAddress'
    ];
    
    sellerFields.forEach(field => {
        const placeholder = new RegExp(`\\{\\{seller\\.${field}\\}\\}`, 'gi');
        result = result.replace(placeholder, preparedData.seller[field]);
    });

    // 3. Заменяем плейсхолдеры покупателя (customer)
    const customerFields = ['name', 'address', 'inn'];
    customerFields.forEach(field => {
        const placeholder = new RegExp(`\\{\\{customer\\.${field}\\}\\}`, 'gi');
        result = result.replace(placeholder, preparedData.customer[field]);
    });

    // 4. Обрабатываем блок items (цикл) с учетом полей InvoiceItem
    const itemsRegex = /\{\{#each items\}\}([\s\S]*?)\{\{\/each\}\}/;
    const match = result.match(itemsRegex);
    
    if (match && preparedData.items.length > 0) {
        const itemsTemplate = match[1];
        let itemsHtml = '';
        
        preparedData.items.forEach(item => {
            let itemHtml = itemsTemplate;
            
            // Заменяем все возможные плейсхолдеры для товара
            const itemFields = [
                'index', 'item_name', 'qty', 'unit', 'price', 'total'
            ];
            
            itemFields.forEach(field => {
                const placeholder = new RegExp(`\\{\\{${field}\\}\\}`, 'gi');
                itemHtml = itemHtml.replace(placeholder, item[field] || '');
            });
            
            // Обрабатываем специальный плейсхолдер для индекса
            itemHtml = itemHtml.replace(/\{\{increment @index\}\}/gi, item.index);
            
            itemsHtml += itemHtml;
        });
        
        result = result.replace(itemsRegex, itemsHtml);
    } else if (match) {
        // Если items пустой - удаляем блок полностью
        result = result.replace(itemsRegex, '');
    }

    // 5. Заменяем оставшиеся плейсхолдеры с точечной нотацией
    const dotNotationRegex = /\{\{([a-zA-Z0-9_.]+)\}\}/gi;
    result = result.replace(dotNotationRegex, (match, path) => {
        const value = getValue(preparedData, path);
        return value !== undefined ? String(value) : '';
    });

    // 6. Удаляем все оставшиеся плейсхолдеры
    result = result.replace(/\{\{[^}]*\}\}/gi, '');

    return result;

}


const getPaidOperations                         = async ( dateString ) => {
    // Запрос к API
    const API_URL = 'https://business.tbank.ru/openapi/api/v1/statement?accountNumber=40702810710001976908&from=' + dateString + '&inns=1400035296';
    
    const BEARER_TOKEN = 't.jZT2bqlMGyGgfNvi3gPV5R-7ZU5gNvixSgYzgjA63GsVF3PHxvpHjAF5zNVuoRbsBntYz_Q6M1n_6Ua4hBQndg';

    const response = await fetch(API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${BEARER_TOKEN}`
      }
    });
  
    if (!response.ok) {
      throw new Error(`Ошибка ${response.status}: ${response.statusText}`);
    }
  
    const data = await response.json();
    // Если структура ответа: { operations: [...] }
    if (!data.operations || !Array.isArray(data.operations)) {
      throw new Error('Некорректный ответ API');
    }
  
    // Маппинг интересующих данных
    const result = data.operations.map(op => ({
        pay_purpose:        op.payPurpose || '',
        inn:                op.payer?.inn || '',
        kpp:                op.payer?.kpp || '',
        amount:             op.operationAmount || 0,
        currency:           op.accountCurrencyDigitalCode || 0,
        doc_date:           op.docDate || '',
        rrn:                op.rrn || ''
    }));
  
    return result;
}


const formatDateWithTimezone                    = (date) => {
    // Функция для добавления ведущего нуля
    const pad = (n) => `${Math.floor(Math.abs(n))}`.padStart(2, '0');
    
    // Получаем смещение временной зоны
    const tzOffset = -date.getTimezoneOffset();
    const diff = tzOffset >= 0 ? '+' : '-';
    const timezoneString = diff + pad(tzOffset / 60) + ':' + pad(tzOffset % 60);
    
    // Формируем строку даты
    return date.getFullYear() +
      '-' + pad(date.getMonth() + 1) +
      '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) +
      ':' + pad(date.getMinutes()) +
      ':' + pad(date.getSeconds()) +
      timezoneString;
}


class SocketHandlers {
    constructor(io) {
        this.io                     = io;
        this.db                     = new DatabaseService();
        this.payment                = new TinkoffPaymentService();
        this.ai                     = new AIService();
        this.passportAI             = new PassportVerificationService();
        this.socketManager          = new SocketManager();
        
        // Привязываем контекст для обработчиков
        this.handleConnection       = this.handleConnection.bind(this);
        this.handleAuth             = this.handleAuth.bind(this);
        this.handleCargo            = this.handleCargo.bind(this);
        this.handleDriver           = this.handleDriver.bind(this);
        this.handleChat             = this.handleChat.bind(this);
        this.handlePayment          = this.handlePayment.bind(this);
        this.handleAI               = this.handleAI.bind(this);
        this.handlePassportCheck    = this.handlePassportCheck.bind(this);

        // this.startChecking()
    }


    startChecking() {
        console.log("start checking...");
        
        if (this.isRunning) {
            console.log('Проверка уже запущена');
            return;
        }

        this.isRunning = true;
        
        // ИСПРАВЛЕНО: добавлены фигурные скобки
        const check = async () => {
            // console.log("check");
            
            try {
                // ИСПРАВЛЕНО: используем метод класса вместо getdata
                let result = await this.db.executeProcedure('check_payment', {});
                
                // console.log("check_payment", result.data);
                
                if (result.success && result.data) {
                    // Проверяем каждый платеж
                    for (const elem of result.data) {
                        try {
                            const status = await this.payment.checkPaymentStatus(elem.paymentId);
                            console.log('check_status', status);
                            
                            if(status.Success){
                                switch (status.Status) {
                                    case "CONFIRMED":           {
                                        this.db.executeProcedure("set_payment",  {id: status.OrderId, orderStatus: 2 })
                                        const socket = this.socketManager.findSocket( elem.user );
                                        if( socket ) await this.handleMethod(socket, 'get_balance', { token: socket.userToken });
                                    } break;
                                    case "DEADLINE_EXPIRED":    this.db.executeProcedure("set_payment",  {id: status.OrderId, orderStatus: 3 });break;
                                    case "REJECTED":            this.db.executeProcedure("set_payment",  {id: status.OrderId, orderStatus: 4 });break;
                                    default: break;
                                }
                                
                            }
                            
                        } catch (err) {
                            console.error("check_status error:", err);
                        }
                    }
                }

                result = await this.db.executeProcedure("get_oper_bound", {});

                if(result.success){
                    result  = await getPaidOperations( result.data )
                    this.db.executeProcedure("set_operations", result );
                }

            } catch (err) {
                console.error("check_payment error:", err);
            }
        };
        
        // Первый запуск
        check();
        
        // Периодические запросы каждую минуту
        this.intervalId = setInterval(() => check(), 30 * 1000);
        
        console.log('Запущена периодическая проверка статуса платежа');
    }

    stopChecking() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            this.isRunning = false;
            console.log('Проверка остановлена');
        }
    }

    async checkToken( params ) {
        try {
            const data = await this.db.getToken( params )
            return data    
        } catch (error) {
            return undefined
        }
        
    }

    async handleMethod(socket, path, params) {
        const startTime = Date.now();
        
        try {
            const data = await this.db.executeProcedure(path, params);
            const duration = Date.now() - startTime;
            console.log(`✅ Метод ${path} выполнен за ${duration}ms`);
            
            socket.emit(path, data);
            return data;
        } catch (error) {
            const duration = Date.now() - startTime;
            console.error(`❌ Ошибка метода ${path} за ${duration}ms:`, error);
            
            const response = {
                success: false,
                message: error.message || "Упс.. какая-то ошибка",
                code: error.code,
                timestamp: new Date().toISOString()
            };
            
            socket.emit(path, response);
            return response;
        }
    }

    handleConnection(socket) {
        console.log('🔌 Новое подключение:', socket.id);
        socket.emit('authenticated', { success: true, message: 'Подключение установлено' });

        // Авторизация
        socket.on('save_password',          (data) => this.handleAuth(socket, 'save_password', data));
        socket.on('authorization',          (data) => this.handleAuth(socket, 'authorization', data));
        socket.on('check_registration',     (data) => this.handleAuth(socket, 'check_registration', data));
        socket.on('check_phone',            (data) => this.handleAuth(socket, 'check_phone', data));
        socket.on('check_sms',              (data) => this.handleAuth(socket, 'check_sms', data));
        socket.on('restore_password',       (data) => this.handleAuth(socket, 'restore_password', data));
        socket.on('set_push_token',         (data) => this.handleAuth(socket, 'set_push_token', data));

        // Грузы
        socket.on('get_cargos',             (data) => this.handleCargo(socket, 'get_cargos', data));
        socket.on('get_cargo_archives',     (data) => this.handleCargo(socket, 'get_cargo_archives', data));
        socket.on('set_cargo',              (data) => this.handleCargo(socket, 'set_cargo', data));
        socket.on('publish_cargo',          (data) => this.handleCargo(socket, 'publish_cargo', data));
        socket.on('set_document',           (data) => this.handleCargo(socket, 'set_document', data));
        socket.on('del_document',           (data) => this.handleCargo(socket, 'del_document', data));
        socket.on('set_inv',                (data) => this.handleCargo(socket, 'set_inv', data));
        socket.on('cancel_offer',           (data) => this.handleCargo(socket, 'del_offer', data));

        // Водители
        socket.on('get_works',              (data) => this.handleDriver(socket, 'get_works', data));
        socket.on('get_work_archives',      (data) => this.handleDriver(socket, 'get_work_archives', data));
        socket.on('set_offer',              (data) => this.handleDriver(socket, 'set_offer', data));
        socket.on('del_offer',              (data) => this.handleDriver(socket, 'del_offer', data));
        socket.on('set_status',             (data) => this.handleDriver(socket, 'set_status', data));

        // Чат
        socket.on('get_chats',              (data) => this.handleChat(socket, 'get_chats', data));
        socket.on('get_messages',           (data) => this.handleChat(socket, 'get_messages', data));
        socket.on('send_message',           (data) => this.handleChat(socket, 'send_message', data));
        socket.on('get_contract',           (data) => this.handleChat(socket, 'get_contract', data));
        socket.on('create_contract',        (data) => this.handleChat(socket, 'create_contract', data));
        socket.on('set_contract',           (data) => this.handleChat(socket, 'set_contract', data));
        socket.on('get_contract',           (data) => this.handleChat(socket, 'get_contract', data));
        socket.on('get_photos',             (data) => this.handleChat(socket, 'get_photos', data));

        // Платежи
        socket.on('create_payment_sbp',     (data) => this.handlePayment(socket, 'create_payment_sbp', data));
        socket.on('get_sbp_banks',          (data) => this.handlePayment(socket, 'get_sbp_banks', data));
        socket.on('create_invoice',         (data) => this.handlePayment(socket, 'create_invoice', data));

        // ЛИЧНЫЙ КАБИНЕТ
        socket.on('get_balance',            (data) => this.handlePersonalAccount(socket, 'get_balance', data));
        socket.on('get_transactions',       (data) => this.handlePersonalAccount(socket, 'get_transactions', data));
        socket.on('get_invoices',           (data) => this.handlePersonalAccount(socket, 'get_invoices', data));
        socket.on('get_agreement',          (data) => this.handlePersonalAccount(socket, 'get_agreement', data));
        socket.on('set_agreement',          (data) => this.handlePersonalAccount(socket, 'set_agreement', data));
        socket.on('get_seller',             (data) => this.handlePersonalAccount(socket, 'get_seller', data));
        socket.on('get_invoice',            (data) => this.handlePersonalAccount(socket, 'get_invoice', data));
        socket.on('get_inv_pdf',            (data) => this.handlePersonalAccount(socket, 'get_inv_pdf', data));
        
        // ПРОФИЛЬ
        socket.on('set_user',               (data) => this.handleProfile(socket, 'set_user', data));
        socket.on('set_passport',           (data) => this.handleProfile(socket, 'set_passport', data));
        socket.on('get_passport',           (data) => this.handleProfile(socket, 'get_passport', data));
        socket.on('upload_doc',             (data) => this.handleUploadDoc(socket, data));
        socket.on('get_doc',                (data) => this.handleGetDoc(socket, data));
        socket.on('check_passport_photo',   (data) => this.handlePassportCheck(socket, 'check_passport_photo', data));
        socket.on('check_passport_registration', (data) => this.handlePassportCheck(socket, 'check_passport_registration', data));
        socket.on('set_transport',          (data) => this.handleProfile(socket, 'set_transport', data));
        socket.on('get_transport',          (data) => this.handleProfile(socket, 'get_transport', data));
        socket.on('set_company',            (data) => this.handleProfile(socket, 'set_company', data));
        socket.on('get_company',            (data) => this.handleProfile(socket, 'get_company', data));
        socket.on('send_email',             (data) => this.handleProfile(socket, 'send_email', data));
        socket.on('set_location',           (data) => this.handleProfile(socket, 'set_location', data));
        
        
        // AI
        socket.on('ai_message',             (data) => this.handleAI(socket, 'ai_message', data));
        socket.on('ai_analyze_cargo',       (data) => this.handleAI(socket, 'ai_analyze_cargo', data));
        socket.on('get_pdf1',               (data) => this.getPDF1( socket, data ));


        // Отключение
        socket.on('disconnect', (reason) => {
            console.log('🔌 Отключение:', socket.id, 'Причина:', reason);
            this.socketManager.unregisterSocket(socket);
        });

        socket.on('error', (error) => {
            console.error('❌ Ошибка сокета:', socket.id, error);
        });
    }

    async handleAuth(socket, event, data) {
        try {
            switch (event) {
                
                case 'check_sms': {
                    const result = await this.db.executeProcedure("check_sms", data);
                    console.log("check_sms result:", result);
    
                    if (!result.success && result.data) {
                        // Ждем проверку кода через шлюз
                        const ch = await checkGatewayCode(result.data, data.pincode);
                        if (ch.success) {
                            socket.emit("check_sms", { success: true, data: result.token });
                            await this.db.executeProcedure("set_pincode", data);
                        } else {
                            socket.emit("check_sms", ch);
                        }
                    } else {
                        socket.emit("check_sms", result);
                    }
                    break;
                }
    
                case 'save_password': {
                    let result = await this.db.executeProcedure("save_password", data);
                    console.log("save_password initial:", result);
    
                    if (!result.success && result.data) {
                        const ch = await checkGatewayCode(result.data, data.sms);
                        if (ch.success) {
                            await this.db.executeProcedure("set_pincode", data);
                            // Повторный вызов сохранения после подтверждения
                            result = await this.db.executeProcedure("save_password", data);
                            socket.emit("save_password", result);
                        } else {
                            socket.emit("save_password", ch);
                        }
                    } else {
                        socket.emit("save_password", result);
                    }
                    break;
                }
    
                case 'check_registration':
                case 'check_phone': {
                    console.log(event, data);
                    const result = await this.db.executeProcedure(event, data);
                    console.log(event, result);
                    if(result.success){
                        if (data.transport === "telegram") {
                            try {
                                const ch = await sendGatewayVerification(result.phone);
                                if (ch.success) {
                                    const params = { phone: data.phone || data.code, requestId: ch.request_id };
                                    await this.db.executeProcedure("set_requestId", params);
                                    socket.emit(event, { success: true, message: "СМС отправлен" });
                                } else {
                                    socket.emit(event, ch);
                                }
                            } catch (e) {
                                console.error("Gateway error:", e);
                            }
                        } else {
                            // Обычное СМС
                            try {
                                const text = "СМС для проверки номера - " + result.pincode 
                                //const ch = await sendSMS(result.phone, text || ""); // текст должен быть в data или определен
                                //console.log('send_sms success', ch);
                                socket.emit(event, { success: true, message: "СМС отправлен" });
                            } catch (e) {
                                console.error('send_sms error', e.message);
                                socket.emit(event, {success: false, message: e.message });
                            }
                        }
                    } else socket.emit(event, result);
                    break;
                }
    
                default: {
                    // Обработка авторизации и прочих методов
                    const result = await this.handleMethod(socket, event, data);
    
                    if (result.success && result.data) {
                        this.socketManager.registerSocket(socket, result.data);
    
                        if (event === 'authorization') {
                            const token = result.data.token;
                            const isDriver = result.data.driver || result.data.user_type === 2;
    
                            // Определяем набор методов для подгрузки данных
                            const methods = isDriver 
                                ? ['get_works', 'get_transport', 'get_work_archives', 'get_passport', 'get_company', 'get_balance']
                                : ['get_cargos', 'get_cargo_archives', 'get_passport', 'get_company', 'get_balance'];
    
                            // Запускаем всё параллельно для скорости
                            await Promise.all(methods.map(m => this.handleMethod(socket, m, { token })));
                        }
                    }
                    break;
                }
            }
        } catch (error) {
            console.error(`❌ Ошибка в handleAuth [${event}]:`, error);
            
            // Универсальный ответ об ошибке в нужный топик
            const errorResponse = {
                success: false,
                message: error.message || "Упс.. какая-то ошибка",
                code: error.code,
                timestamp: new Date().toISOString()
            };
            
            // Отправляем ошибку именно в тот топик, который запрашивали
            socket.emit(event, errorResponse);
        }
    }
    
    async handleCargo(socket, event, data) {
        try {
            let result;
            
            switch(event) {
                case 'set_cargo':
                    result = await this.handleMethod(socket, 'set_cargo', data);
                    if (result.success) {
                        await this.handleMethod(socket, 'get_cargos', { token: data.token });
                    }
                    break;
                    
                case 'publish_cargo':
                    result = await this.handleMethod(socket, 'publish', data);
                    if (result.success) {
                        // Уведомляем водителей о новом грузе
                        this.socketManager.broadcastToUserType(2, 'new_cargo', result.data);
                    }
                    break;
                    
                case 'set_document':
                    result = await this.handleMethod(socket, 'set_document', data);
                    if (result.success) {
                        // Уведомляем водителей о новом грузе
                        await this.handleMethod(socket, 'get_balance', { token: data.token });
                    }
                    break;
                        
                case 'del_document':
                    result = await this.handleMethod(socket, 'del_document', data);
                    if (result.success) {
                        // Уведомляем водителей о новом грузе
                        await this.handleMethod(socket, 'get_balance', { token: data.token });
                    }
                    break;
                            
                    case 'set_inv':
                        result = await this.handleMethod(socket, 'set_inv', data);
                        if (result.success) {
                            // Уведомляем водителей о новом грузе
                            await this.handleMethod(socket, 'get_cargos', { token: data.token });
                            const recipientSocket = this.socketManager.findSocket(data.recipient);
                            if (recipientSocket) {
                                await this.handleMethod(recipientSocket, 'get_works', { 
                                    token: recipientSocket.userToken 
                                });
                            }
                        }
                        break;
                                    
                    case 'del_offer':
                        result = await this.handleMethod(socket, 'del_offer', data);
                        if (result.success) {
                            // Уведомляем водителей о новом грузе
                            await this.handleMethod(socket, 'get_cargos', { token: data.token });
                            const recipientSocket = this.socketManager.findSocket(data.recipient);
                            if (recipientSocket) {
                                await this.handleMethod(recipientSocket, 'get_works', { 
                                    token: recipientSocket.userToken 
                                });
                            }
                        }
                        break;
                                
                    default:
                    await this.handleMethod(socket, event, data);
            }
        } catch (error) {
            console.error(`❌ Ошибка обработки груза ${event}:`, error);
        }
    }

    async handleDriver(socket, event, data) {
        try {
            let result = await this.handleMethod(socket, event, data);
            
            // Уведомляем заказчика об изменениях
            if (result.success && data.recipient) {
                const recipientSocket = this.socketManager.findSocket(data.recipient);
                if (recipientSocket) {
                    await this.handleMethod(recipientSocket, 'get_cargos', { 
                        token: recipientSocket.userToken 
                    });
                }
                await this.handleMethod(socket, 'get_works', data)
            }
        } catch (error) {
            console.error(`❌ Ошибка обработки водителя ${event}:`, error);
        }
    }

    async handleChat(socket, event, data) {
        try {
            let result;
            
            switch(event) {
                case 'send_message':
                    result = await this.handleMethod(socket, 'send_message', data);
                    if (result.success) {
                        await this.handleMethod(socket, 'get_chats', data);
                        await this.handleMethod(socket, 'get_messages', data);
                        
                        // Уведомляем получателя
                        const recipientSocket = this.socketManager.findSocket(data.recipient);
                        if (recipientSocket) {
                            await this.handleMethod(recipientSocket, 'get_chats', {
                                token: recipientSocket.userToken
                            });
                            await this.handleMethod(recipientSocket, 'get_messages', {
                                token: recipientSocket.userToken,
                                cargo: data.cargo,
                                recipient: socket.userId
                            });
                        }
                    }
                    break;
                    
                case 'get_contract':
                    result = await this.handleMethod(socket, 'get_contract', data);
                    break;
                    
                default:
                    await this.handleMethod(socket, event, data);
            }
        } catch (error) {
            console.error(`❌ Ошибка обработки чата ${event}:`, error);
        }
    }

    async handlePayment(socket, event, data) {
        try {
            switch(event) {
                case 'create_payment_sbp':
                    // Сначала создаем запись в БД
                    const dbResult = await this.handleMethod(socket, 'create_payment', data);
                    
                    const now = new Date();

                    // Добавляем 5 минут
                    now.setMinutes(now.getMinutes() + 5);

                    // Форматируем результат
                    const formattedDate = formatDateWithTimezone(now);

                    if (dbResult.success) {
                        // Создаем платеж в Tinkoff
                        const paymentData = {
                            orderId:                    dbResult.id || `sbp_${Date.now()}`,
                            amount:                     data.amount * 100,
                            description:                data.description,
                            phone:                      data.phone,
                            RedirectDueDate:            formattedDate, 
                            success_url:                `https://gruzreis.ru/payment/success?payment_id=${dbResult.id}`,
                            fail_url:                   `https://gruzreis.ru/payment/fail?payment_id=${dbResult.id}`,
                            callback_url:               `https://gruzreis.ru/api/tinkoff_callback`
                        };
                        
                        const paymentResult = await this.payment.createSBPPayment(paymentData);
                        if (paymentResult.success) {
                            // Сохраняем данные платежа
                            const param_s = {
                                id:                     dbResult.id,
                                paymentId:              paymentResult.payment_id,
                                paymentUrl:             paymentResult.payment_url,
                                qrUrl:                  paymentResult.qr_url,
                                sbpPayload:             paymentResult.sbp_payload
                            }
                            
                            console.log("param_s", param_s)

                            await this.handleMethod(socket, 'set_payment', param_s );
                            
                            socket.emit('create_payment_sbp', {
                                success: true,
                                data: {
                                    payment_id:         paymentResult.payment_id,
                                    order_id:           paymentResult.order_id,
                                    payment_url:        paymentResult.payment_url,
                                    qr_code:            paymentResult.qr_url,
                                    sbp_payload:        paymentResult.sbp_payload,
                                    sbp_deep_link:      paymentResult.sbp_deep_link,
                                    payment_method:     'sbp',
                                    status:             paymentResult.status,
                                    amount:             data.amount
                                }
                            });
                        } else {
                            socket.emit('create_payment_sbp', {
                                success: false,
                                message: paymentResult.message
                            });
                        }
                    }
                    break;
                    
                case 'get_sbp_banks':
                    // Здесь можно добавить логику получения банков если нужно
                    socket.emit('get_sbp_banks', {
                        success: true,
                        data: { banks: [] } // Заглушка
                    });
                    break;
                default:
                    await this.handleMethod(socket, event, data);
            }
        } catch (error) {
            console.error(`❌ Ошибка обработки платежа ${event}:`, error);
            socket.emit(event, {
                success: false,
                message: 'Ошибка обработки платежа'
            });
        }
    }

    async handleAI(socket, event, data) {
        try {
            let result;
            switch(event) {
                case 'get_pdf1': {
                        


                    }; break;
                    
                case 'ai_analyze_cargo':
                    result = await this.ai.analyzeCargo(data.cargo, data.action);
                    break;
            }
            
            socket.emit(event, result);
        } catch (error) {
            console.error(`❌ Ошибка AI ${event}:`, error);
            socket.emit(event, {
                success: false,
                message: 'Ошибка AI сервиса'
            });
        } finally {
            socket.emit('ai_typing', { isTyping: false });
        }
    }

    async handlePersonalAccount(socket, event, data) {
        console.log("handle - " + event, data )
        try {
            let result;
            
            switch(event) {
                case 'get_balance':
                    result = await this.handleMethod(socket, 'get_balance', data);
                    break;
                    
                case 'get_transactions':
                    result = await this.handleMethod(socket, 'get_transactions', data);
                    break;
                    
                case 'get_agreement':
                    result = await this.handleMethod(socket, 'get_agreement', data);
                    break;
                    
                case 'get_inv_pdf':

                    break;
                        
                case 'set_agreement':
                    result = await this.handleMethod(socket, 'set_agreement', data);
                    if (result.success) {
                        // Можно отправить подтверждение или обновленные данные
                        socket.emit('agreement_updated', { success: true });
                    }
                    break;
                    
                default:
                    await this.handleMethod(socket, event, data);
            }
            
            return result;
        } catch (error) {
            console.error(`❌ Ошибка обработки ЛК ${event}:`, error);
            socket.emit(event, {
                success: false,
                message: 'Ошибка обработки запроса ЛК'
            });
        }
    }

    async handleUploadDoc(socket, data) {
        try {
            const token = data?.token;
            const filename = data?.filename;
            const raw = data?.image || data?.file;

            const user = await this.checkToken({ token });
            if (!user) {
                return socket.emit('upload_doc', {
                    success: false,
                    message: 'Неверный токен',
                });
            }
            if (!filename) {
                return socket.emit('upload_doc', {
                    success: false,
                    message: 'filename обязателен',
                });
            }

            const { buffer, mimeType } = decodeBase64File(
                raw,
                data?.mimeType || data?.mime_type || 'application/octet-stream'
            );

            if (buffer.length > 20 * 1024 * 1024) {
                return socket.emit('upload_doc', {
                    success: false,
                    message: 'Файл больше 20 MB',
                });
            }

            const result = await uploadFotos(filename, buffer, mimeType);
            socket.emit('upload_doc', { success: true, ...result });
            return result;
        } catch (error) {
            console.error('❌ upload_doc:', error.message);
            socket.emit('upload_doc', {
                success: false,
                message: error.message || 'Ошибка загрузки файла',
            });
        }
    }

    async handleGetDoc(socket, data) {
        try {
            const token = data?.token;
            const key = data?.filename || data?.key || data?.filePath;

            const user = await this.checkToken({ token });
            if (!user) {
                return socket.emit('get_doc', {
                    success: false,
                    message: 'Неверный токен',
                });
            }
            if (!key) {
                return socket.emit('get_doc', {
                    success: false,
                    message: 'filename (key) обязателен',
                });
            }

            const { filePath, buffer, contentType } = await getFotosBuffer(key);
            socket.emit('get_doc', {
                success: true,
                filePath,
                contentType,
                data: buffer.toString('base64'),
            });
        } catch (error) {
            console.error('❌ get_doc:', error.message);
            socket.emit('get_doc', {
                success: false,
                message: error.message || 'Ошибка получения файла',
            });
        }
    }

    async handlePassportCheck(socket, event, data) {
        try {
            const resolved = await resolveImageInput(data || {});
            const options = {
                mimeType: resolved.mimeType,
                expected: data?.expected,
            };

            let result;
            if (event === 'check_passport_photo') {
                result = await this.passportAI.verifyPassportPhoto(resolved.image, options);
            } else {
                result = await this.passportAI.verifyPassportRegistration(resolved.image, options);
            }

            if (resolved.filePath) {
                result = { ...result, filePath: resolved.filePath };
            }

            socket.emit(event, result);
            return result;
        } catch (error) {
            console.error(`❌ Ошибка проверки паспорта [${event}]:`, error);
            const response = {
                success: false,
                message: error.message || 'Ошибка проверки паспорта',
            };
            socket.emit(event, response);
            return response;
        }
    }

    async handleProfile(socket, event, data) {
        try {
            let result;
            
            switch(event) {
                case 'set_passport':
                    result = await this.handleMethod(socket, 'set_passport', data);
                    if (result.success) {
                        // После сохранения паспорта загружаем обновленные данные
                        console.log("set_passport", data)
                        await this.handleMethod(socket, 'get_passport', data);
                    }
                    break;
                    
                case 'set_transport':
                    result = await this.handleMethod(socket, 'set_transport', data);
                    if (result.success) {
                        // После сохранения транспорта загружаем обновленные данные
                        await this.handleMethod(socket, 'get_transport', data);
                    }
                    break;
                    
                case 'set_company':
                    result = await this.handleMethod(socket, 'set_company', data);
                    if (result.success) {
                        // После сохранения компании загружаем обновленные данные
                        await this.handleMethod(socket, 'get_company', data);
                    }
                    break;
                    
                default:
                    result = await this.handleMethod(socket, event, data);
            }
            
            return result;
        } catch (error) {
            console.error(`❌ Ошибка обработки профиля ${event}:`, error);
            socket.emit(event, {
                success: false,
                message: 'Ошибка обработки запроса профиля'
            });
        }
    }

    async getPDF1 (socket, params) {

        try {
            const res = await this.db.executeProcedure("get_contract", params);
            // Загрузка шаблона и JSON с данными
    
            const templatePath = path.join(__dirname, 'templates', 'cargo_agree.html');
                
            const htmlTemplate = fs.readFileSync(templatePath, 'utf8');;
    
            const filledTemplate = fillTemplate(htmlTemplate, res.data);
    
            const pdf = await toPDF( filledTemplate )

    
            socket.emit( "get_pdf1", {success: true, data: pdf  })
    
        } catch (error) {
            console.error(`❌ Ошибка метода ${path} `, error);
            
            const response = {
                success: false,
                message: error.message || "Упс.. какая-то ошибка",
                code: error.code,
                timestamp: new Date().toISOString()
            };
            
            socket.emit(path, response);
            return response;
        }
    
    }

    async getPDF2 (socket, params) {

        try {
    
            const templatePath = path.join( __dirname, 'templates', 'invoice.html' );
                
            const htmlTemplate = fs.readFileSync( templatePath, 'utf8' );

            const filledTemplate = fillTemplate1( htmlTemplate, params );
    
            const pdf = await toPDF( filledTemplate )

    
            socket.emit( "get_inv_pdf", {success: true, data: pdf  })
    
        } catch (error) {
            console.error(`❌ Ошибка метода ${path} `, error);
            
            const response = {
                success: false,
                message: error.message || "Упс.. какая-то ошибка",
                code: error.code,
                timestamp: new Date().toISOString()
            };
            
            socket.emit(path, response);
            return response;
        }
    
    }
    
}



module.exports = SocketHandlers;