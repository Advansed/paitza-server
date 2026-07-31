try {
    require('dotenv').config();
    console.log('✅ Файл .env загружен');
} catch (error) {
    console.log('⚠️ Файл .env не найден, используем переменные окружения системы');
}

const express       = require('express');
const http          = require('http');
const https         = require('https');
const socketIo      = require('socket.io');
const cors          = require('cors');
const axios         = require('axios');
const sql           = require('mssql');
const Anthropic     = require('@anthropic-ai/sdk');
const crypto        = require('crypto');



const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY, // Добавьте ключ в .env файл
});

// Конфигурация базы данных с улучшенными настройками pool
const sqlConfig = {
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'cargos',
    server: process.env.DB_SERVER || 'localhost',
    
    pool: {
        max:                        10,          // Максимальное количество соединений в пуле
        min:                        2,           // Минимальное количество соединений
        idleTimeoutMillis:          30000,  // Время жизни неактивного соединения
        acquireTimeoutMillis:       60000,  // Время ожидания получения соединения
        createTimeoutMillis:        60000,   // Время ожидания создания соединения
        destroyTimeoutMillis:       5000,   // Время ожидания закрытия соединения
        reapIntervalMillis:         1000,     // Интервал проверки неактивных соединений
        createRetryIntervalMillis:  200  // Интервал повторных попыток создания соединения
    },
    
    options: {
        encrypt:                    true,
        trustServerCertificate:     true,
        enableArithAbort:           true,
        requestTimeout:             30000,        // Время ожидания запроса
        connectionTimeout:          30000,     // Время ожидания подключения
        parseJSON:                  true,              // Автоматический парсинг JSON
        abortTransactionOnError:    false
    },
    
    // Настройки для обработки ошибок
    connectionTimeout:              30000,
    requestTimeout:                 30000,
    stream:                         false,
    parseJSON:                      true
};

// Глобальный пул соединений
let globalPool                      = null;
let isPoolConnecting                = false;

// Функция инициализации пула соединений
async function initializePool() {
    if (globalPool) {
        return globalPool;
    }
    
    if (isPoolConnecting) {
        // Ждем завершения текущего подключения
        while (isPoolConnecting) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return globalPool;
    }
    
    try {
        isPoolConnecting = true;
        console.log('Инициализация пула соединений с базой данных...');
        
        globalPool = new sql.ConnectionPool(sqlConfig);
        
        // Обработчики событий пула
        globalPool.on('connect', () => {
            console.log('✅ Пул соединений подключен к базе данных');
        });
        
        globalPool.on('close', () => {
            console.log('❌ Пул соединений закрыт');
            globalPool = null;
        });
        
        globalPool.on('error', (err) => {
            console.error('❌ Ошибка пула соединений:', err);
            globalPool = null;
        });
        
        await globalPool.connect();
        console.log('✅ Пул соединений успешно инициализирован');
        
        return globalPool;
        
    } catch (error) {
        console.error('❌ Ошибка инициализации пула соединений:', error);
        globalPool = null;
        throw error;
    } finally {
        isPoolConnecting = false;
    }
}

// Функция получения пула с переподключением
async function getPool() {
    if (!globalPool || !globalPool.connected) {
        return await initializePool();
    }
    return globalPool;
}

// Улучшенная функция для работы с базой данных через пул
async function getdata(path, params, f_success, f_error) {
    let request = null;
    
    try {
        console.log(`🔍 Выполняем запрос: p_${path}`);
        console.log('📝 Параметры:', JSON.stringify(params, null, 2));
        
        // Получаем пул соединений
        const pool = await getPool();
        
        // Создаем новый request из пула
        request = pool.request();
        
        // Добавляем input параметр для процедуры
        //  request.input('json', sql.NVarChar(sql.MAX), JSON.stringify(params));
        request.input('json', JSON.stringify(params));
        
        // Выполняем хранимую процедуру
        const result = await request.execute(`p_${path}`);
        
        console.log(`✅ Запрос p_${path} выполнен успешно`);
        
        // Проверяем результат
        if (result.recordset && result.recordset.length > 0) {
            const record = result.recordset[0];
            
            if (record.data !== undefined) {
                try {
                    const parsedData = typeof record.data === 'string' 
                        ? JSON.parse(record.data) 
                        : record.data;
                    
                    f_success(parsedData);
                } catch (parseError) {
                    console.error('❌ Ошибка парсинга JSON:', parseError);
                    f_error({ message: "Ошибка парсинга данных из базы" });
                }
            } else {
                console.log('⚠️ Поле data не найдено в результате');
                f_error({ message: "Данные не найдены" });
            }
        } else {
            console.log('⚠️ Пустой результат запроса');
            f_error({ message: "Пустой результат запроса" });
        }
        
    } catch (error) {
        console.error(`❌ Ошибка выполнения p_${path}:`, error);
        
        // Обработка различных типов ошибок
        let errorMessage = "Ошибка базы данных";
        
        if (error.code === 'ETIMEOUT') {
            errorMessage = "Превышено время ожидания запроса";
        } else if (error.code === 'ECONNRESET') {
            errorMessage = "Соединение с базой данных прервано";
            // Сбрасываем пул для переподключения
            if (globalPool) {
                globalPool.close();
                globalPool = null;
            }
        } else if (error.number) {
            // SQL Server ошибка
            errorMessage = `Ошибка SQL Server: ${error.message}`;
        }
        
        f_error({ 
            message: errorMessage,
            code: error.code,
            number: error.number
        });
        
    } finally {
        // Request автоматически освобождается при завершении
        // Соединение возвращается в пул автоматически
    }
}

async function method(path, socket, params) {
    const startTime = Date.now();
    
    try {
        await getdata(path, params,
            (data) => {
                const duration = Date.now() - startTime;
                console.log(`✅ Метод ${path} выполнен за ${duration}ms`);
                console.log('📤 Отправляем результат через сокет');
                
                // Отправляем успешный результат через сокет
                socket.emit(path, data);
                return data 
            },
            (error) => {
                const duration = Date.now() - startTime;
                console.error(`❌ Ошибка метода ${path} за ${duration}ms:`, error);
                
                const response = {
                    success: false,
                    message: error.message || "Упс.. какая-то ошибка",
                    code: error.code,
                    timestamp: new Date().toISOString()
                };
                
                // Отправляем ошибку через сокет
                socket.emit(path, response);
                return response
            }
        );
    } catch (error) {
        console.error(`❌ Критическая ошибка в методе ${path}:`, error);
        
        socket.emit(path, {
            success: false,
            message: "Критическая ошибка сервера",
            timestamp: new Date().toISOString()
        });
    }
}

// SMS API ключ (добавьте в переменные окружения)
const SMS_API_KEY = process.env.SMS_API_KEY;

// Инициализация Express приложения
const app = express();
const server = http.createServer(app);

// app.use(cors({
//     origin: [
//       'https://gruzreis.ru',
//       'https://www.gruzreis.ru',
//       'http://localhost:3000',
//       'http://localhost:8100'
//     ],
//     credentials: true,
//     methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
//   }));

// Настройка Socket.IO
const io = socketIo(server, {
    transports: ['websocket', 'polling'],
});


// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Логирование запросов
app.use((req, res, next) => {
    next();
});


// Map для хранения комнат чата
const chatRooms             = new Map();

// Глобальные Maps для индексации сокетов
const socketsByUserType     = new Map(); // user_type -> Set(sockets)
const socketsByUserId       = new Map();   // userId -> socket

// Socket.IO обработчики
io.on('connection', (socket) => {

    console.log('🔌 Новое подключение:', socket.id);

    // Отправляем подтверждение подключения
    socket.emit('authenticated', { success: true, message: 'Подключение установлено' });

    // Регистрация
    socket.on('save_password', (data) => {
        console.log('💾 Сохранение пароля');
        getdata('save_password', data,
            (js) => {
                console.log('✅ Пароль сохранен');
                socket.emit("save_password", js);
                 if (js.success && js.data) {
                    socket.userId       = js.data.guid
                    socket.userName     = js.data.name
                    socket.userToken    = js.data.token
                    socket.user_type    = js.data.user_type

                    if (js.data.driver) {
                        method('get_works', socket, { token: js.data.token });
                        method('get_transport', socket, { token: js.data.token });
                        method("hist_works", socket, data);

                    } else {
                        method('get_cargos', socket, { token: js.data.token });
                    }
                }
            },
            (error) => {
                console.error('❌ Ошибка сохранения пароля:', error);
                socket.emit("save_password", { success: false, message: error.message });
            }
        );
    });

    socket.on('check_registration', (data) => {
        data.pincode = '5555'
        getdata("check_registration", data,
            (js) => {
                if (js.success) {
                    socket.emit("check_registration", { 
                        success: true, 
                        data: {
                            token: js.data.token,
                            user_data: js.data.user_data
                        } 
                    });
                } else {
                    socket.emit("check_registration", js );
                }
            },
            (error) => {
                socket.emit("check_registration", {
                    success: false, 
                    message: error.message
                });
            }
        );
    });

    socket.on('check_restore', (data) => {
      data.pincode = '5555'
      getdata("check_restore", data
          , (js) => {
              if (js.success) {
                socket.emit("check_restore", { 
                    success: true, 
                    data: {
                        token: js.data.token,
                        user_data: js.data.user_data
                    } 
                });
                // Если пользователь найден, инициируем звонок
                //   getCall(js.data.phone
                //       , (ch) => {
                //           const callData = JSON.parse(ch);
                //           console.log( callData )
                //           socket.emit("check_restore", { 
                //               success: true, 
                //               data: {
                //                   ...callData, 
                //                   token: js.data.token,
                //                   user_data: js.data.user_data
                //               } 
                //           });
                //       }
                //       , (error) => {
                //           socket.emit("check_restore", { 
                //               success: false, 
                //               message: "Ошибка сервиса звонков" 
                //           });
                //       }
                //   );
              } else {
                  socket.emit("check_restore", { 
                      success: false, 
                      message: js.message || "Пользователь с таким номером не найден" 
                  });
              }
          }
          , (error) => {
              socket.emit("check_restore", {
                  success: false, 
                  message: error.message || "Ошибка базы данных"
              });
          }
      );
    });

    socket.on('check_sms', (data) => {
        
        getdata("check_sms", data
            , (ch) => {
                //const callResult = JSON.parse(ch);
                socket.emit("check_sms", ch );
            }
            , (error) => {
                socket.emit("check_sms", {
                    success: false,
                    message: error.message || "Ошибка проверки звонка"
                });
            }
        );
    });

    socket.on('restore_password', (data) => {
        
        getdata('restore_password', data
            , (js) => {
                socket.emit("restore_password", js);
                
                // Если восстановление успешно, загружаем данные пользователя
                if (js.success && js.data.driver) {
                    method('get_works', socket, { token: js.data.token });
                    method('get_transport', socket, { token: js.data.token });
                } else if (js.success) {
                    method('get_cargos', socket, { token: js.data.token });
                }
            }
            , (error) => {
                socket.emit("restore_password", {
                    success: false, 
                    message: error.message || "Ошибка восстановления пароля"
                });
            }
        );
    });

    socket.on('authorization', (data) => {
        getdata("authorization", data,
            (js) => {
                socket.emit("authorization", js);
                if (js.success && js.data) {
                    
                    socket.userId       = js.data.id
                    socket.userName     = js.data.name
                    socket.userToken    = js.data.token
                    socket.user_type    = js.data.user_type

                    if (socket.userId && socket.user_type) {
                        socketsByUserId.set(socket.userId, socket);
                        if (!socketsByUserType.has(socket.user_type)) {
                            socketsByUserType.set(socket.user_type, new Set());
                        }
                        socketsByUserType.get(socket.user_type).add(socket);
                    }

                    if (js.data.user_type === 2) {

                        method('get_works',             socket, { token: js.data.token });

                        method('get_transport',         socket, { token: js.data.token });

                        method('get_company',           socket, { token: js.data.token });

                        method('get_passport',          socket, { token: js.data.token });

                        method("hist_works",            socket, { token: js.data.token });

                    } else {

                        method('get_cargos',            socket, { token: js.data.token });

                        method('get_cargo_archives',    socket, { token: js.data.token });

                        method('get_company',           socket, { token: js.data.token });

                        method('get_passport',          socket, { token: js.data.token });

                    }
                }
            },
            (error) => {
                socket.emit("authorization", {
                    success: false, 
                    message: error.message
                });
            }
        );
    });

    socket.on('re_authorize', (data) => {
        console.log("re authorize", data)
        getdata("re_authorize", data,
            (js) => {
                if (js.success && js.data) {
                    socket.userId       = js.data.id
                    socket.userName     = js.data.name
                    socket.userToken    = js.data.token
                    socket.user_token   = js.data.user_token

                    if (socket.userId && socket.user_type) {
                        socketsByUserId.set(socket.userId, socket);
                        if (!socketsByUserType.has(socket.user_type)) {
                            socketsByUserType.set(socket.user_type, new Set());
                        }
                        socketsByUserType.get(socket.user_type).add(socket);
                    }
                }
            },
            (error) => {
                socket.emit("re_athorize", {
                    success: false, 
                    message: error.message
                });
            }
        );
    });

    // Профиль
    socket.on('set_user', (data) => {
        console.log('👤 Загрузка профиля');
        method('set_user', socket, data);
    });

    socket.on('set_passport', async(data) => {
        console.log('🚚 Сохранение паспорта');
        await method("set_passport", socket, data ) ;
        method("get_passport", socket, data )
    });

    socket.on('get_passport', (data) => {
        console.log('🚚 Получение паспорта');
        method("get_passport", socket, data )
    });

    socket.on('set_transport', async(data) => {
        console.log('🚚 Сохранение транспорта', data);
        await method("set_transport", socket, data);
        method("get_transport", socket, data )
    });

    socket.on('get_transport', async(data) => {
        console.log('🚚 Получение транспорта');
        await method("get_transport", socket, data);
        method("get_transport", socket, data )
    });

    socket.on('set_company', async(data) => {
        console.log('🚚 Сохранение организации');
        await method("set_company", socket, data )
        method("get_company", socket, data)
    });

    socket.on('get_company', (data) => {
        console.log('🚚 Сохранение организации');
        method("get_company", socket, data )
    });

    // Админ-панель
    socket.on('admin_get_managers', (data) => {
        console.log('🛡️ Список менеджеров');
        method('admin_get_managers', socket, data);
    });

    socket.on('admin_add_manager', async (data) => {
        console.log('🛡️ Добавление менеджера');
        await method('admin_add_manager', socket, data);
    });

    socket.on('admin_set_manager_active', async (data) => {
        console.log('🛡️ Статус менеджера');
        await method('admin_set_manager_active', socket, data);
    });


    
    // Заказчик
    socket.on('get_cargos', async (data) => {
        await method("get_cargos", socket, data);        
    });

    socket.on('get_cargo_archives', async (data) => {
        await method("get_cargo_archives", socket, { ...data, archive: 1} );        
    });

    socket.on('save_cargo', async (data) => {
        console.log('📦 Сохранение груза');
        await method("set_cargo", socket, data);
        await method("get_cargos", socket, { token: data.token })
    });

    socket.on('set_advance', async(data) => {
        console.log('🚚 Сохранение аванса');
        await method("set_advance", socket, data ) ;
        method("get_cargos", socket, data )
    });

    socket.on('set_insurance', async(data) => {
        console.log('🚚 Сохранение страховки');
        await method("set_insurance", socket, data ) ;
        method("get_cargos", socket, data )
    });

    socket.on('publish_cargo', async (data) => {
        console.log('📢 Публикация заказа');
        await method("publish", socket, data);

        const sockets = socketsByUserType.get( 2 );
            if (sockets) {
                sockets.forEach(socket => {
                    socket.emit(event, data);
                });
            }    
        });

    socket.on('set_inv', async (data) => {
        console.log('🧾 Установка инвойса');
        await method("set_inv", socket, data);
        await method("get_cargos", socket, data);

        let f_socket = findSocket( data.recipient )
        
        if(f_socket){ 
            method("get_works", f_socket, {
            token:      f_socket.userToken,
            })
        }

    });

    socket.on('completed', async (data) => {
        console.log('✅ Завершение заказа');
        await method("completed", socket, data);
        await method("get_cargos", socket, data);

        let f_socket = findSocket( data.recipient )
        if(f_socket) method("get_works", f_socket, {
            token:      f_socket.userToken,
        })

    });
   

    // Водитель
    socket.on('get_works', async (data) => {
        await method("get_works", socket, data);        
        await method("hist_works", socket, data);
    });

    socket.on('get_work_archives', async (data) => {
        await method("get_work_archives", socket, data);        
    });

    socket.on('get_transport', async (data) => {
        await method("get_transport", socket, data);        
    });

    socket.on('set_offer', async (data) => {
        await method("set_offer", socket, data);
        await method("get_works", socket, data);        
        let f_socket = findSocket( data.recipient )
        if(f_socket){
            method("get_cargos", f_socket, {
            token:      f_socket.userToken,
        })
        } 
    });

    socket.on('set_status', async (data) => {
        await method("set_status", socket, data);
        await method("get_works", socket, data);        
        let f_socket = findSocket( data.recipient )
        if(f_socket){
            method("get_cargos", f_socket, {
            token:      f_socket.userToken,
        })
        } 
    });

    socket.on('delivered', async (data) => {
        await method("delivered", socket, data);
        await method("get_works", socket, data);
        let f_socket = findSocket( data.recipient )
        
        if(f_socket){ 
            method("get_cargos", f_socket, {
                token:      f_socket.userToken,
            })
        }
    });

    socket.on('set_agreement', async (data) => {
        console.log('🚚 Установка соглашений');
        await method("set_agreement", socket, data);
    });

    socket.on('create_payment', async (data) => {
        console.log('🚚 Установка оплаты');
        TINKOFF_PAYMENT_INSTANCE.createPayment( socket, data)
    });

    socket.on('create_payment_sbp', async (data) => {
        console.log('🚚 Установка оплаты');
        TINKOFF_PAYMENT_INSTANCE.createSBP( socket, data)
    });

    socket.on('get_sbp_banks', async (data) => {
        console.log('🚚 Установка оплаты');
        TINKOFF_PAYMENT_INSTANCE.getActiveSBPBanks(socket);
    });

    socket.on('get_agreement', async (data) => {
        console.log('🚚 Установка соглашений');
        await method("get_agreement", socket, data);
    });

    socket.on('get_transactions', async (data) => {
        console.log('🚚 Получить транзакции');
        await method("get_transactions", socket, data);
    });

    
    //Чат
    socket.on('get_chats', (data) => {
        method("get_chats", socket, data)
    });

    socket.on('get_messages', (data) => {
        method("get_messages", socket, data)
    });

    socket.on('send_message', async( data ) => {

        await method( "send_message", socket, data )
        
        await method( "get_chats", socket, data)
        
        await method( "get_messages", socket, data)
        
        let f_socket = findSocket( data.recipient )
        if(f_socket){
            await method("get_chats", f_socket, {
                token:  f_socket.userToken
            })
            await method("get_messages", f_socket, {
                token:      f_socket.userToken,
                cargo:      data.cargo,
                recipient:  socket.userId
            })
        } 
    });

    socket.on('mark_as_read', async( data ) => {
        await method( "mark_as_read", socket, data )
        
        let f_socket = findSocket( data.recipient )
        if(f_socket) method("get_messages", f_socket, {
            token:      f_socket.userToken,
            cargo:      data.cargo,
            recipient:  socket.userId
        })
    });


    socket.on('ai_message', async (data) => {

        console.log('🤖 Claude запрос от пользователя:', socket.userId);
        const systemMessage = "Ты - ИИ-помощник для логистической платформы грузоперевозок.";
             
        try {
            const { message } = data;
            
            // Отправляем индикатор печати
            socket.emit('ai_typing', { isTyping: true });

            // Запрос к Claude API
            const response = await anthropic.messages.create({
                model:          'claude-opus-4-1-20250805',
                max_tokens:     1500,
                temperature:    0.7,
                system:         systemMessage,
                messages:       message
            });

            const assistantMessage = response.content[0].text;
            
            // Отправляем ответ клиенту
            socket.emit('ai_message', {
                success:        true,
                message:        assistantMessage,
                usage:          response.usage,
                timestamp:      new Date()
            });

            // Логируем использование
            console.log(`✅ Claude ответ отправлен. Токены: ${response.usage.total_tokens}`);

        } catch (error) {
            console.error('❌ Ошибка Claude API:', error);
            
            let errorMessage = 'Ошибка при обработке запроса к AI';
            if (error.status === 429) {
                errorMessage = 'Превышен лимит запросов. Попробуйте позже';
            } else if (error.status === 401) {
                errorMessage = 'Ошибка авторизации API';
            }

            socket.emit('ai_message', {
                success:        false,
                message:        errorMessage,
                error:          error.message
            });
        } finally {
            socket.emit('ai_typing', { isTyping: false });
        }
    });

    // Стриминг версия для длинных ответов
    socket.on('ai_stream', async (data) => {
        console.log('🤖 Claude стриминг запрос');
        
        try {
            const { message } = data;
            
            const stream = await anthropic.messages.create({
                model:          'claude-opus-4-1-20250805',
                max_tokens:     2000,
                temperature:    0.7,
                messages:       session.getMessages(),
                stream:         true,
            });

            let fullContent = '';

            for await (const chunk of stream) {
                if (chunk.type === 'content_block_delta') {
                    fullContent += chunk.delta.text;
                    socket.emit('claude_stream_chunk', {
                        text: chunk.delta.text,
                        fullContent: fullContent
                    });
                }
            }

            socket.emit('ai_stream', {
                success:        true,
                fullContent:    fullContent,
                timestamp:      new Date()
            });

        } catch (error) {
            console.error('❌ Ошибка Claude стриминга:', error);
            socket.emit('ai_error', {
                success:        false,
                message:        'Ошибка стриминга',
                error:          error.message
            });
        }
    });

    // Анализ груза с помощью Claude
    socket.on('ai_analyze_cargo', async (data) => {
        console.log('📦 Анализ груза через Claude');
        
        try {
            const { cargo, action } = data;
            
            let prompt = '';
            
            switch(action) {
                case 'optimize_route':
                    prompt = `Проанализируй маршрут доставки груза и предложи оптимизацию:
                        От: ${cargo.address}
                        До: ${cargo.destiny}
                        Груз: ${cargo.name}
                        Вес: ${cargo.weight} кг
                        Объем: ${cargo.volume} м³
                        Дата загрузки: ${cargo.pickup_date}`;

                    break;
                    
                case 'calculate_price':
                    prompt = `Рассчитай рекомендуемую стоимость перевозки:
                        От: ${cargo.address}
                        До: ${cargo.destiny}
                        Вес: ${cargo.weight} кг`;

                    break;
                    
                case 'check_documents':
                    prompt = `Какие документы необходимы для перевозки:
                        Тип груза: ${cargo.cargo_type}
                        Международная перевозка: ${cargo.international ? 'Да' : 'Нет'}
                        Опасный груз: ${cargo.dangerous ? 'Да' : 'Нет'}`;
                    break;
            }

            const response = await anthropic.messages.create({
                model: 'claude-opus-4-1-20250805',
                max_tokens: 1000,
                temperature: 0.5,
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            });

            socket.emit('ai_analyze_cargo', {
                success: true,
                analysis: response.content[0].text,
                action: action,
                timestamp: new Date()
            });

        } catch (error) {
            console.error('❌ Ошибка анализа груза:', error);
            socket.emit('ai_analyze_cargo', {
                success: false,
                message: 'Ошибка анализа',
                error: error.message
            });
        }
    });

    // Помощь водителю с документами
    socket.on('ai_driver_help', async (data) => {
        console.log('🚛 Помощь водителю через Claude');
        
        try {
            const { question, driverData } = data;
            
            const systemPrompt = `Ты помощник для водителей грузовиков. 
            Данные водителя:
            - Опыт: ${driverData?.experience || 'неизвестно'} лет
            - Тип транспорта: ${driverData?.transport_type || 'неизвестно'}
            - Регион работы: ${driverData?.region || 'неизвестно'}
            
            Отвечай конкретно и практично.`;

            const response = await anthropic.messages.create({
                model: 'claude-opus-4-1-20250805',
                max_tokens: 1000,
                temperature: 0.6,
                system: systemPrompt,
                messages: [{
                    role: 'user',
                    content: question
                }]
            });

            socket.emit('claude_driver_response', {
                success: true,
                answer: response.content[0].text,
                timestamp: new Date()
            });

        } catch (error) {
            console.error('❌ Ошибка помощи водителю:', error);
            socket.emit('claude_driver_response', {
                success: false,
                message: 'Ошибка получения ответа',
                error: error.message
            });
        }
    });


    // Получение истории сессии
    socket.on('ai_get_history', (data) => {
        const { sessionId } = data;
        const session = claudeSessions.get(sessionId || socket.userId);
        
        if (session) {
            socket.emit('claude_history', {
                success: true,
                messages: session.getMessages(),
                context: session.context,
                createdAt: session.createdAt,
                lastActivity: session.lastActivity
            });
        } else {
            socket.emit('claude_history', {
                success: false,
                message: 'История не найдена'
            });
        }
    });

    // Выход
    socket.on('disconnect', (reason) => {
        console.log('🔌 Отключение:', socket.id, 'Причина:', reason);

        if (socket.userId) {
            socketsByUserId.delete(socket.userId);
        }
        
        if (socket.user_type && socketsByUserType.has(socket.user_type)) {
            socketsByUserType.get(socket.user_type).delete(socket);
        }
    });

    socket.on('error', (error) => {
        console.error('❌ Ошибка сокета:', socket.id, error);
    });

});

function findSocket(userId) {
    return socketsByUserId.get(userId) || null;
}


// REST API endpoints
app.get('/api/status', async (req, res) => {
    try {
        const pool = await getPool();
        const isDbConnected = pool && pool.connected;
        
        res.json({
            status:         'running',
            database:       isDbConnected ? 'connected' : 'disconnected',
            connections:    io.engine.clientsCount,
            rooms:          chatRooms.size,
            uptime:         process.uptime(),
            memory:         process.memoryUsage(),
            timestamp:      new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/notify', (req, res) => {
    try {
        const { type, data } = req.body;
        
        if (!type) {
            return res.status(400).json({ 
                success: false, 
                message: 'Тип уведомления обязателен' 
            });
        }
        
        console.log('📢 Отправка уведомления:', type);
        io.emit('notification', { type, data, timestamp: new Date().toISOString() });
        
        res.json({ 
            success: true, 
            message: 'Уведомление отправлено',
            recipients: io.engine.clientsCount
        });
    } catch (error) {
        console.error('❌ Ошибка отправки уведомления:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Ошибка отправки уведомления' 
        });
    }
});

app.post('/api/sendimage', async(req, res) => {
    
    
    try {
        const { token, recipient, cargo, image } = req.body;
        
        console.log("api/sendimage", token, recipient, cargo, image.substring(0, 50))

        const params = {
            token:      token,
            cargo:      cargo,
            recipient:  recipient,
            image:      image,
            message:    ""
        }
        try {
            await getdata('send_image', params,
                (data) => {
                    console.log("send_image", data)
                    let js = JSON.parse(data)
                    if(js.success){
                        const f_socket = findSocket( recipient )
                        if(f_socket){
                            method("get_chats", f_socket, {
                                token:  f_socket.userToken
                            })
                            method("get_messages", f_socket, {
                                token:      f_socket.userToken,
                                cargo:      cargo,
                                recipient:  js.guid
                            })
                        } 
                        res.json( JSON.parse(data))                        
                    } else res.json({success: false, message: js.message })
                },
                (error) => {
                    res.json({success: false, message: error.message })
                }
            );
        } catch (error) {
            res.json({success: false, message: '! ' + error.message })
        }
    } catch (error) {
        res.json({success: false, message: '!!! ' + error.message })
    }
})

app.post('/api/tinkoff_payment', async(req, res) => {
    try {
        console.log(req.body)
    } catch (error) {
        res.json({success: false, message: '!!! ' + error.message })
    }
})


// Middleware для обработки ошибок
app.use((error, req, res, next) => {
    console.error('❌ Необработанная ошибка:', error);
    res.status(500).json({
        success: false,
        message: 'Внутренняя ошибка сервера',
        timestamp: new Date().toISOString()
    });
});

// Обработка необработанных отклонений промисов
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Необработанное отклонение промиса:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Необработанное исключение:', error);
    // Graceful shutdown
    gracefulShutdown();
});

// Graceful shutdown
async function gracefulShutdown() {
    console.log('🔄 Начинаем graceful shutdown...');
    
    try {
        // Закрываем HTTP сервер
        server.close(() => {
            console.log('✅ HTTP сервер закрыт');
        });
        
        // Закрываем Socket.IO соединения
        io.close(() => {
            console.log('✅ Socket.IO сервер закрыт');
        });
        
        // Закрываем пул соединений с базой данных
        if (globalPool) {
            await globalPool.close();
            console.log('✅ Пул соединений с БД закрыт');
        }
        
        console.log('✅ Graceful shutdown завершен');
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Ошибка при graceful shutdown:', error);
        process.exit(1);
    }
}


// Обработчики сигналов для graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Запуск сервера
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        // Инициализируем пул соединений при запуске
        await initializePool();
        
        server.listen(PORT, () => {
            console.log(`🚀 Socket.IO сервер запущен на порту ${PORT}`);
            console.log(`📊 Статус сервера: http://localhost:${PORT}/api/status`);
        });
        
    } catch (error) {
        console.error('❌ Ошибка запуска сервера:', error);
        process.exit(1);
    }
}

function sendSMS(phone, pincode, f_success, f_error) {
  
  if (!checkRateLimit(phone, 'sms', 3, 60000)) {
    return f_error(new Error('SMS rate limit exceeded'));
  }

  const options = {
    host: SMS_CONFIG.host,
    port: 443,
    path: encodeURI(`/sms/send?api_id=${SMS_CONFIG.apiId}&to=${phone}&msg=${pincode}&json=1`),
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    }
  };

  const req_ = https.request(options, function(res_) {
    const chunks = [];
    res_.setEncoding('utf8');
    res_.on('data', function (chunk) {
      chunks.push(chunk);
    });

    res_.on('end', function () {
      f_success(chunks[0]);
    });
  });
  
  req_.on('error', function(e) {
    console.error('❌ SMS send error:', e.message);
    f_error(e);
  });

  req_.end();
}

class TINKOFF_SERVICE {
    constructor() {
        this.config = {
            baseURL:        'https://securepay.tinkoff.ru/v2/',
            terminalKey:    '1759318435409',
            password:       'EYsXNiLe22TdyIia'
        };
    }

    /**
     * Создание платежной сессии для СБП
     */
    async createSBPPaymentSession(orderData) {
        const requestData = {
            TerminalKey:        this.config.terminalKey,
            Amount:             orderData.amount,
            OrderId:            orderData.orderId,
            Description:        orderData.description,
            SuccessURL:         orderData.success_url,
            FailURL:            orderData.fail_url,
            NotificationURL:    orderData.callback_url,
            PayType:            'O', // O - одностадийная оплата (для СБП)
            DATA: {
                Email:          orderData.email,
                Phone:          orderData.phone,
                QrCode:         'QRCode', // Запрашиваем QR-код
                PaymentMethod:  'sbp'
            },
            Receipt:            orderData.receipt
        };

        // Создаем подпись для Init
        requestData.Token = this.createToken({
            Amount:           requestData.Amount,
            Description:      requestData.Description,
            FailURL:          requestData.FailURL,
            NotificationURL:  requestData.NotificationURL,
            OrderId:          requestData.OrderId,
            SuccessURL:       requestData.SuccessURL,
            PayType:          requestData.PayType,
            Password:         this.config.password,
            TerminalKey:      this.config.terminalKey
        });

        try {
            console.log('🔄 Отправляем Init запрос для СБП:', requestData);
            const response = await axios.post(`${this.config.baseURL}Init`, requestData);

            console.log('Init', response.data )
            if (response.data.Success) {
                console.log('✅ Init успешен, получаем QR для PaymentId:', response.data.PaymentId);
                
                // Получаем QR-код для СБП
                const qrResult = await this.getQrCode({
                    PaymentId:      response.data.PaymentId,
                    DataType:       'PAYLOAD' // Получаем payload для СБП
                });
                console.log( 'GetQr', qrResult )

                return {
                    success:        true,
                    payment_id:     response.data.PaymentId,
                    payment_url:    response.data.PaymentURL,
                    order_id:       response.data.OrderId,
                    status:         response.data.Status,
                    qr_url:         qrResult.qr_url,
                    sbp_payload:    qrResult.sbp_payload,
                    sbp_deep_link:  qrResult.sbp_deep_link,
                    qr_image:       qrResult.qr_image // Base64 изображение QR-кода
                };
            } else {
                console.error('❌ Init ошибка:', response.data);
                return {
                    success:        false,
                    message:        response.data.Message + ": " + (response.data.Details || ''),
                    error_code:     response.data.ErrorCode
                };
            }

        } catch (error) {
            console.error('❌ Tinkoff SBP payment error:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data || error.message
            };
        }
    }

    /**
     * Получение QR-кода для СБП через метод GetQr
     */
    async getQrCode(qrData) {
        const requestData = {
            TerminalKey: this.config.terminalKey,
            PaymentId:   qrData.PaymentId,
            DataType:    qrData.DataType || 'PAYLOAD' // PAYLOAD или IMAGE
        };

        // Создаем токен для GetQr
        requestData.Token = this.createToken({
            TerminalKey: requestData.TerminalKey,
            PaymentId:   requestData.PaymentId,
            DataType:    requestData.DataType,
            Password:    this.config.password
        });

        try {
            console.log('🔄 Запрашиваем QR код:', requestData);
            const response = await axios.post(`${this.config.baseURL}GetQr`, requestData);

            if (response.data.Success) {
                console.log('✅ QR код получен успешно');
                
                const result = {
                    qr_url: response.data.QrCodeUrl, // URL для отображения QR-кода
                    sbp_payload: response.data.Data // PAYLOAD для СБП
                };

                // Генерируем deep link для СБП
                if (response.data.Data) {
                    result.sbp_deep_link = this.generateSBPDeepLink(response.data.Data);
                }

                // Если нужна картинка QR-кода в base64
                if (qrData.DataType === 'IMAGE' && response.data.QrCodeImage) {
                    result.qr_image = response.data.QrCodeImage;
                }

                return result;
            } else {
                console.warn('⚠️ QR code not available:', response.data);
                return {
                    qr_url: null,
                    sbp_payload: null,
                    sbp_deep_link: null
                };
            }
        } catch (error) {
            console.error('❌ Tinkoff GetQr error:', error.response?.data || error.message);
            return {
                qr_url: null,
                sbp_payload: null,
                sbp_deep_link: null
            };
        }
    }

    /**
     * Получение списка банков-участников СБП
     */
    async getSBPBankList() {
        const requestData = {
            TerminalKey:    this.config.terminalKey,
            ScenarioType:   "qr",
            Device:         {
                Type:   "mobile",
                Os:     "android"
            },
        };

        // Создаем токен для GetQrBankList
        requestData.Token = this.createToken({
            TerminalKey:    requestData.TerminalKey,
            Password:       this.config.password,
            ScenarioType:   "qr",
        });

        try {
            console.log('🔄 Запрашиваем список банков СБП:', requestData);
            const response = await axios.post(`${this.config.baseURL}GetQrBankList`, requestData);

            if (response.data.Success) {
                console.log('✅ Список банков получен успешно');
                
                return {
                    success: true,
                    banks: this.formatBankList(response.data.Banks),
                    total_count: response.data.Banks ? response.data.Banks.length : 0
                };
            } else {
                console.warn('⚠️ Bank list not available:', response.data);
                return {
                    success: false,
                    message: response.data.Message || 'Не удалось получить список банков',
                    error_code: response.data.ErrorCode
                };
            }
        } catch (error) {
            console.error('❌ Tinkoff GetQrBankList error:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data || error.message
            };
        }
    }

    /**
     * Форматирование списка банков для удобного использования
     */
    formatBankList(banks) {
        if (!banks || !Array.isArray(banks)) {
            return [];
        }

        return banks.map(bank => ({
            id: bank.BankId,
            name: bank.BankName,
            logo_url: bank.LogoURL,
            is_active: bank.IsActive === true,
            sort_order: bank.SortOrder || 0,
            // Дополнительные поля, если они есть в ответе
            ...bank
        })).sort((a, b) => {
            // Сортируем по IsActive (активные первыми) и затем по SortOrder
            if (a.is_active !== b.is_active) {
                return a.is_active ? -1 : 1;
            }
            return (a.sort_order || 0) - (b.sort_order || 0);
        });
    }

    /**
     * Получение отформатированного списка банков с группировкой
     */
    async getFormattedBankList() {
        const bankListResult = await this.getSBPBankList();
        
        console.log('bankList', bankListResult )
        if (!bankListResult.success) {
            return bankListResult;
        }

        const banks = bankListResult.banks;
        
        // Группируем банки по активности
        const activeBanks = banks.filter(bank => bank.is_active);
        const inactiveBanks = banks.filter(bank => !bank.is_active);

        return {
            success: true,
            data: {
                active_banks: activeBanks,
                inactive_banks: inactiveBanks,
                total_active: activeBanks.length,
                total_inactive: inactiveBanks.length,
                total: banks.length
            }
        };
    }

    /**
     * Генерация deep link для СБП
     */
    generateSBPDeepLink(payload) {
        if (!payload) return null;
        
        // Формируем deep link для мобильных приложений банков
        // Стандартный формат для СБП
        return `https://qr.nspk.ru/${payload}`;
        
        // Альтернативные форматы для разных банков
        // return `bank://qr.nspk.ru/${payload}`;
        // return `sbp://pay?payload=${encodeURIComponent(payload)}`;
    }

    /**
     * Универсальный метод создания токена
     */
    createToken(requestData) {
        // Убираем Token из данных для подписи
        const data = { ...requestData };
        if (data.Token) delete data.Token;
        
        // Сортируем ключи в алфавитном порядке
        const sortedKeys = Object.keys(data).sort();
        const values = sortedKeys.map(key => data[key]);
        
        // Конкатенируем значения
        const concatenated = values.join('');
        
        console.log('🔐 Данные для токена:', {
            sortedKeys,
            values,
            concatenated
        });
        
        // Создаем SHA256 хеш
        return crypto.createHash('sha256')
            .update(concatenated, 'utf8')
            .digest('hex');
    }
}

// Обновленный класс TINKOFF_PAYMENT с методами для работы со списком банков
class TINKOFF_PAYMENT {
    constructor() {
        this.bankService = new TINKOFF_SERVICE();
    }

    /**
     * Создание платежа через СБП
     */
    async createSBP(socket, data) {
        try {
            const { token, type, amount, description, cargo, phone } = data;

            // Сначала создаем запись о платеже в базе данных
            getdata("create_payment", { token, type, amount, description, cargo }, 
                async (js) => {
                    console.log('💳 SBP Payment DB result:', js);

                    if (js.success) {
                        const orderData = {
                            orderId:        js.id || `sbp_${Date.now()}`,
                            amount:         amount * 100,
                            description:    description,
                            phone:          phone || js.phone,
                            email:          js.email || '',
                            success_url:    `https://gruzreis.ru/payment/success?payment_id=${js.id}`,
                            fail_url:       `https://gruzreis.ru/payment/fail?payment_id=${js.id}`,
                            callback_url:   `https://gruzreis.ru/api/tinkoff_callback`  ////gruzreis.ru/api/tinkoff_callback
                        };

                        // Создаем платежную сессию СБП
                        const paymentResult = await this.bankService.createSBPPaymentSession(orderData);

                        if (paymentResult.success) {
                            // Сохраняем данные платежа в БД
                            getdata("set_payment", { 
                                id: js.id, 
                                paymentId:  paymentResult.payment_id, 
                                paymentUrl: paymentResult.payment_url,
                                qrUrl:      paymentResult.qr_url,
                                sbpPayload: paymentResult.sbp_payload
                            }, 
                            (ch) => {
                                console.log('💾 set_payment SBP result:', ch);
                                console.log(ch.success)
                                if (ch.success) {
                                    // Отправляем клиенту полные данные для СБП оплаты
                                    console.log('emit create_payment')
                                    const raw = {
                                        success: true, 
                                        data: {
                                            payment_id:         paymentResult.payment_id,
                                            order_id:           paymentResult.order_id,
                                            payment_url:        paymentResult.payment_url,
                                            payment_method:     'sbp',
                                            
                                            // Данные для СБП
                                            qr_code: paymentResult.qr_url, // URL QR-кода
                                            sbp_payload: paymentResult.sbp_payload, // PAYLOAD для ручного ввода
                                            sbp_deep_link: paymentResult.sbp_deep_link, // Deep link для приложений
                                            
                                            // Инструкции
                                            instructions: this.getSBPInstructions(paymentResult.sbp_payload),
                                            
                                            // Статус
                                            status: paymentResult.status,
                                            amount: amount
                                        }
                                    }
                                    console.log('emit', raw)
                                    socket.emit("create_payment_sbp", raw );

                                    // Логируем успех
                                    console.log('✅ SBP платеж создан:', {
                                        payment_id: paymentResult.payment_id,
                                        order_id: paymentResult.order_id,
                                        has_qr: !!paymentResult.qr_url,
                                        has_payload: !!paymentResult.sbp_payload
                                    });

                                } else {
                                    socket.emit("create_payment", { 
                                        success: false, 
                                        message: "Не удалось сохранить запись о платеже СБП" 
                                    });
                                }
                            }, 
                            (err) => {
                                console.error('❌ SBP payment DB error:', err);
                                socket.emit("create_payment", { 
                                    success: false, 
                                    message: "Ошибка базы данных: " + err.message 
                                });
                            });

                        } else {
                            console.error('❌ SBP payment creation failed:', paymentResult);
                            socket.emit("create_payment", {
                                success: false, 
                                message: paymentResult.message || "Ошибка создания платежа СБП",
                                error_code: paymentResult.error_code
                            });
                        }

                    } else {
                        socket.emit('create_payment', { 
                            success: false, 
                            message: js.message || 'Ошибка создания платежа СБП в базе данных' 
                        });
                    }
                },
                (error) => {
                    console.error('❌ SBP Database error:', error);
                    socket.emit('create_payment', { 
                        success: false, 
                        message: 'Ошибка базы данных при создании платежа СБП'
                    });
                }
            );

        } catch (error) {
            console.error('❌ SBP Payment creation error:', error);
            socket.emit('create_payment', {
                success: false,
                message: 'Внутренняя ошибка сервера при создании платежа СБП: ' + error.message
            });
        }
    }

    /**
     * Получение списка банков СБП
     */
    async getSBPBankList(socket) {
        try {
            console.log('🔄 Запрашиваем список банков СБП...');
            const bankListResult = await this.bankService.getFormattedBankList();

            if (bankListResult.success) {
                console.log('✅ Список банков получен, отправляем клиенту');
                socket.emit("sbp_bank_list", {
                    success: true,
                    data: bankListResult.data
                });
            } else {
                console.error('❌ Ошибка получения списка банков:', bankListResult);
                socket.emit("sbp_bank_list", {
                    success: false,
                    message: bankListResult.message || 'Не удалось получить список банков',
                    error_code: bankListResult.error_code
                });
            }
        } catch (error) {
            console.error('❌ Get SBP bank list error:', error);
            socket.emit("sbp_bank_list", {
                success: false,
                message: 'Внутренняя ошибка сервера при получении списка банков: ' + error.message
            });
        }
    }

    /**
     * Получение упрощенного списка банков (только активные)
     */
    async getActiveSBPBanks(socket) {
        try {
            const bankListResult = await this.bankService.getFormattedBankList();
            
            if (bankListResult.success) {
                socket.emit("get_sbp_banks", {
                    success: true,
                    data: {
                        banks: bankListResult.data.active_banks,
                        count: bankListResult.data.total_active
                    }
                });
            } else {
                socket.emit("get_sbp_banks", {
                    success: false,
                    message: bankListResult.message
                });
            }
        } catch (error) {
            console.error('❌ Get active SBP banks error:', error);
            socket.emit("get_sbp_banks", {
                success: false,
                message: 'Ошибка получения списка банков'
            });
        }
    }

    /**
     * Динамические инструкции для оплаты через СБП
     */
    getSBPInstructions(sbpPayload) {
        const instructions = {
            title: "Оплата через СБП",
            methods: []
        };

        // Метод 1: QR-код
        instructions.methods.push({
            title: "Через QR-код",
            steps: [
                "Откройте приложение вашего банка",
                "Найдите раздел 'Оплата по QR-коду'",
                "Отсканируйте QR-код",
                "Подтвердите платеж"
            ]
        });

        // Метод 2: По номеру телефона (если есть payload)
        if (sbpPayload) {
            instructions.methods.push({
                title: "По номеру телефона",
                steps: [
                    "Откройте приложение вашего банка",
                    "Выберите 'Перевод по СБП'",
                    `Введите номер телефона: ${this.getPhoneFromPayload(sbpPayload)}`,
                    "Подтвердите перевод"
                ]
            });
        }

        // Метод 3: Ручной ввод
        if (sbpPayload) {
            instructions.methods.push({
                title: "Ручной ввод",
                steps: [
                    "Откройте приложение вашего банка",
                    "Выберите 'Перевод по СБП'",
                    "Введите данные вручную при необходимости",
                    "Подтвердите платеж"
                ],
                note: `Payload: ${sbpPayload}`
            });
        }

        instructions.note = "Оплата обычно проходит в течение 1-2 минут";

        return instructions;
    }

    /**
     * Вспомогательный метод для извлечения номера телефона из payload
     */
    getPhoneFromPayload(payload) {
        // В реальной реализации здесь может быть логика парсинга payload
        // Для примера возвращаем заглушку
        return "СИСТЕМА СБП";
    }
}


class TinkoffPaymentChecker {
    constructor(terminalKey, secretKey) {
        this.terminalKey = terminalKey;
        this.secretKey = secretKey;
        this.isRunning = false;
        this.intervalId = null;
    }

    // Генерация токена (упрощенная версия)
    generateToken(paymentId) {
        const crypto = require('crypto');
        const data = {
            TerminalKey: this.terminalKey,
            Password: this.secretKey,
            PaymentId: paymentId
        };
        
        const sortedValues = Object.values(data).sort().join('');
        console.log('hash', sortedValues)
        return crypto.createHash('sha256')
            .update(sortedValues)
            .digest('hex');
    }

    async checkPaymentStatus(paymentId) {
        try {
            const token = this.generateToken(paymentId);
            
            console.log("axios", {
                TerminalKey:    this.terminalKey,
                PaymentId:      paymentId,
                Token:          token
            })

            const response = await axios.post('https://securepay.tinkoff.ru/v2/GetState', {
                TerminalKey:    this.terminalKey,
                PaymentId:      paymentId,
                Token:          token
            }, {
                timeout: 10000, // таймаут 10 секунд
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            console.log(response.data)

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

    startChecking( paymentId, callback = null) {
        console.log("start checking...")
        if (this.isRunning) {
            console.log('Проверка уже запущена');
            return;
        }

        this.isRunning = true;
        
        const check = ()=>
            console.log("check")
            getdata("check_payment", {}
                , (js)=>{
                    console.log("check_paym ent", js.data)
                    if(js.success) {
                        js.data.forEach(elem => {
                            this.checkPaymentStatus( elem.paymentId ).then( data => {
                                console.log('check_status', data)
                            }).catch((err)=>{
                                console.log("check_status", err)
                            })                            
                        });
                    }
                }
                , (err)=>{ console.log("check_payment error ", err)}
            )
        
        check()

        // Периодические запросы
        this.intervalId = setInterval(async () => check(), 60 * 1000);

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
}

        //    terminalKey:    '1759318435409',
        //    password:       'EYsXNiLe22TdyIia'
// // Использование
const checker = new TinkoffPaymentChecker('1759318435409', 'EYsXNiLe22TdyIia');

// Запуск проверки
checker.startChecking('your_payment_id', (paymentData) => {
    // Обработка данных платежа
    if (paymentData.Status === 'CONFIRMED') {
        console.log('Платеж подтвержден!');
        checker.stopChecking();
    }
});

// Остановка через 10 минут
setTimeout(() => {
    checker.stopChecking();
}, 10 * 60 * 1000);

const TINKOFF_PAYMENT_INSTANCE = new TINKOFF_PAYMENT();

startServer();
