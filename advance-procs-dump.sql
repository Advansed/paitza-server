

-- ========== p_set_cargo ==========


-- Процедура p_set_cargo
CREATE PROCEDURE [dbo].[p_set_cargo](
    @json NVARCHAR(MAX)
)
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @user_id        UNIQUEIDENTIFIER
    DECLARE @token          UNIQUEIDENTIFIER
    DECLARE @cargo_id       UNIQUEIDENTIFIER
    DECLARE @from_address   NVARCHAR(500)
    DECLARE @to_address     NVARCHAR(500)
    
    BEGIN TRY
        SELECT 
            guid, name, description, address, destiny, phone, face, weight, volume, price, cost, advance, pickup_date, delivery_date
        INTO #temp_cargo
        FROM OPENJSON(@json)
        WITH (
            guid            NVARCHAR(36)        '$.guid',
            name            NVARCHAR(255)       '$.name',
            description     NVARCHAR(1024)      '$.description',
            phone           NVARCHAR(24)        '$.phone',
            face            NVARCHAR(128)       '$.face',
            weight          DECIMAL(15, 3)      '$.weight',
            volume          DECIMAL(15, 3)      '$.volume',
            price           DECIMAL(15, 2)      '$.price',
            cost            DECIMAL(15, 2)      '$.cost',
            advance         DECIMAL(15, 2)      '$.advance',
            address         NVARCHAR(MAX)       '$.address' AS JSON,
            destiny         NVARCHAR(MAX)       '$.destiny' AS JSON,
            pickup_date     DATE                '$.pickup_date',
            delivery_date   DATE                '$.delivery_date'
        )
        
        SET @token = CAST(JSON_VALUE(@json, '$.token') AS UNIQUEIDENTIFIER)
        
        SELECT @user_id = id FROM t_users WHERE token = @token
        
        IF (@user_id IS NULL)
        BEGIN
            SELECT '{"success": false, "message": "Invalid token"}' AS data
            RETURN
        END
        
        SET @cargo_id = case when JSON_VALUE(@json, '$.guid')  is null or JSON_VALUE(@json, '$.guid')  = '' then NEWID() else JSON_VALUE(@json, '$.guid') end
        
		DELETE FROM t_cargo WHERE id = @cargo_id

        INSERT INTO t_cargo (
             id,code,name,to_address,from_address,weight
            ,contact_phone,client,price,cost,advance,pickup_date
            ,delivery_date,description,contact_name,volume, insurance
        )
        SELECT 
            @cargo_id,                                          
            dbo.Code(1),                                        
            name,                                               
            destiny,                                            
            address,                                            
            weight,                                             
            phone,                                              
            @user_id,                                           
            price,                                              
            cost,                                               
            advance,                                            
            pickup_date,                                        
            delivery_date,                                      
            description,                                        
            face,                                               
            volume,                                             
            0
        FROM #temp_cargo
        
        DROP TABLE #temp_cargo
        
        SELECT '{"success": true, "message": "Cargo created successfully"}' AS data
        
    END TRY
    BEGIN CATCH
        IF OBJECT_ID('tempdb..#temp_cargo') IS NOT NULL
            DROP TABLE #temp_cargo
            
        SELECT '{"success": false, "message": "Server error: ' + ERROR_MESSAGE() + '"}' AS data
    END CATCH
END


-- ========== p_get_cargos ==========


-- Процедура p_get_cargos
CREATE PROCEDURE [dbo].[p_get_cargos](
    @json NVARCHAR(MAX)
)
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @token UNIQUEIDENTIFIER;
    DECLARE @out NVARCHAR(MAX);
    DECLARE @user UNIQUEIDENTIFIER;
    
    BEGIN TRY
        SELECT @token = CAST(token AS UNIQUEIDENTIFIER) FROM OPENJSON(@json) WITH ( token NVARCHAR(36) '$.token' );
        
        IF @token IS NULL BEGIN SELECT '{"success": false, "message": "Token not specified"}' AS data; RETURN; END;
        
        SELECT @user = id FROM t_users WHERE token = @token;
        
        IF @user IS NULL BEGIN SELECT '{"success": false, "message": "Invalid token"}' AS data; RETURN; END;
        
        WITH TransportStatuses1 AS (
            SELECT 
                cargo,
                MAX( CASE WHEN status % 2 = 1 THEN status END )        AS max_odd_status,
                MIN( CASE WHEN status % 2 = 0 THEN status END )        AS min_even_status,
                COUNT( * )                                             AS total_invoices,
                SUM( weight )                                          AS total_weight,
                SUM( volume )                                          AS total_volume,
                SUM( CASE WHEN status = 20 THEN 1 ELSE 0 END )         AS count_completed
            FROM t_transportations
            WHERE status BETWEEN 11 AND 20
            GROUP BY cargo
        ),

        TransportStatuses2 AS (
            SELECT 
                cargo,
                MAX( status )       AS max_status
            FROM t_transportations
            GROUP BY cargo having MAX(status) = 10
        ),

        InvoicesData AS (
            SELECT 
                t.cargo,
                IsNull(JSON_QUERY((
                    SELECT 
                        (t2.id) AS guid,
                        (t2.cargo) AS cargo,
                        (t2.client) AS recipient,
                        u.name AS client,
                        t2.weight,
                        t2.volume,
                        CASE t2.status 
                            WHEN 11 THEN 'Заказано'
                            WHEN 12 THEN 'Принято' 
                            WHEN 13 THEN 'На погрузке'
                            WHEN 14 THEN 'Загружается'
                            WHEN 15 THEN 'Загружено'
                            WHEN 16 THEN 'В пути'
                            WHEN 17 THEN 'Доставлено'
                            WHEN 18 THEN 'Разгружается'
                            WHEN 19 THEN 'Разгружено'
                            WHEN 20 THEN 'Завершено'
                        END AS status,
                        t2.status AS status_code,
                        tr.name AS transport,
                        tr.load_capacity AS capacity,
                        ISNULL((
                            SELECT FORMAT(CAST(SUM(rating) * 1.0 / NULLIF(COUNT(CASE WHEN rating > 0 THEN 1 END), 0) AS NUMERIC(3, 2)), 'N2')
                            FROM t_transportations 
                            WHERE client = t2.client AND rating > 0
                        ), '0.00') AS rating,
                        t2.cost AS price,
                        CASE WHEN t2.status % 2 = 1 THEN 1 ELSE 0 END AS requires_action
                    FROM t_transportations t2
                    LEFT JOIN t_transport tr ON tr.id = t2.transport
                    LEFT JOIN t_users u ON u.id = t2.client
                    WHERE t2.cargo = t.cargo 
                    AND t2.status BETWEEN 11 AND 20
                    FOR JSON PATH
                )), JSON_ARRAY()) AS invoices_json
            FROM t_transportations t
            WHERE t.status BETWEEN 10 AND 20
            GROUP BY t.cargo
        )
        
        SELECT @out = (
            SELECT 
                (c.id)                                   AS guid,
                c.name                                              AS name,
                ISNULL(c.description, '')                           AS description,
                JSON_QUERY(c.from_address)                          AS address,
                JSON_QUERY(c.to_address)                            AS destiny,
                ISNULL(c.contact_phone, '')                         AS phone,
                ISNULL(c.contact_name, '')                          AS face,
                ISNULL(c.weight, 0)                                 AS weight,
                ISNULL(ts.total_weight, 0)                          AS ordered_weight,
                ISNULL(c.volume, 0)                                 AS volume,
                ISNULL(c.price, 0)                                  AS price,
                ISNULL(c.cost, 0)                                   AS cost,
                ISNULL(d1.amount, 0)                                AS advance,
                ISNULL(d2.amount, 0)                                AS insurance,
                ISNULL(FORMAT(c.pickup_date, 'yyyy-MM-dd'), '')     AS pickup_date,
                ISNULL(FORMAT(c.delivery_date, 'yyyy-MM-dd'), '')   AS delivery_date,
                
                CASE
                    WHEN ts1.cargo IS not null THEN 'В ожидании'
                    WHEN ts.cargo IS NULL THEN 'Новый'
                    WHEN ts.max_odd_status IS NOT NULL THEN
                        CASE ts.max_odd_status
                            WHEN    11  THEN    'Есть заказы'
                            WHEN    13  THEN    'Ждет загрузку'
                            WHEN    15  THEN    'Есть загруженные'
                            WHEN    17  THEN    'Есть доставленные'
                            WHEN    19  THEN    'Ждут завершения'
                            ELSE            'Проблемы'
                        END
                    ELSE
                        CASE ts.min_even_status
                            WHEN    12  THEN    'Принято'
                            WHEN    14  THEN    'Загружается'
                            WHEN    16  THEN    'В пути'
                            WHEN    18  THEN    'Разгружается'
                            WHEN    20  THEN    'Завершено'
                            ELSE            'Проблемы'
                        END
                END AS status,
                
                CASE
                    WHEN ts.cargo IS NULL THEN 0
                    WHEN ts.max_odd_status IS NOT NULL THEN ts.max_odd_status
                    ELSE ts.min_even_status
                END AS status_code,
                
                CASE WHEN ts.max_odd_status IS NOT NULL THEN 1 ELSE 0 END AS requires_action,

                ISNULL(id.invoices_json, JSON_ARRAY()) AS invoices
                
            FROM t_cargo c
                LEFT JOIN TransportStatuses1 ts      ON c.id = ts.cargo
                LEFT JOIN TransportStatuses2 ts1     ON c.id = ts1.cargo
                LEFT JOIN InvoicesData id            ON c.id = id.cargo
                LEFT JOIN t_documents d1             ON c.id = d1.cargo and d1.type = 1
                LEFT JOIN t_documents d2             ON c.id = d2.cargo and d2.type = 2
            WHERE c.client = @user 
                AND NOT (IsNull(ts.count_completed, 1) = IsNull(ts.total_invoices, 2) AND IsNull(ts.total_invoices, 0) > 0)
            FOR JSON PATH
        );
        
        IF(@out IS NULL)
			SELECT '{"success": false, "message": "Ошибка в данных или не найдены"}' AS data;
		else        
			SELECT '{"success": true, "data": ' + @out + '}' AS data;
        
    END TRY
    BEGIN CATCH
        SELECT '{"success": false, "message": "Server error: ' + ERROR_MESSAGE() + '"}' AS data;
    END CATCH
END;


-- ========== p_get_cargo_archives ==========

CREATE PROCEDURE [dbo].[p_get_cargo_archives](
    @json NVARCHAR(MAX)
)
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @token UNIQUEIDENTIFIER;
    DECLARE @out NVARCHAR(MAX);
    DECLARE @user UNIQUEIDENTIFIER;
    
    BEGIN TRY
        -- Parse JSON input
        SELECT @token = CAST(token AS UNIQUEIDENTIFIER) FROM OPENJSON(@json) WITH ( token NVARCHAR(36) '$.token' );
        
        -- Validate token
        IF @token IS NULL BEGIN SELECT '{"success": false, "message": "Token not specified"}' AS data; RETURN; END;
        
        -- Find user by token
        SELECT @user = id  FROM t_users  WHERE token = @token;
        
        IF @user IS NULL BEGIN SELECT '{"success": false, "message": "Invalid token"}' AS data; RETURN; END;
        
        -- CTE для агрегированных данных по статусам (только завершенные грузы)
        WITH TransportStatuses1 AS (
            SELECT 
                cargo,
                MAX( CASE WHEN status % 2 = 1 THEN status END )		AS max_odd_status,
                MIN( CASE WHEN status % 2 = 0 THEN status END )		AS min_even_status,
                COUNT( * )											AS total_invoices,
                SUM( weight )										AS total_weight,
                SUM( volume )										AS total_volume,
                SUM( CASE WHEN status = 20 THEN 1 ELSE 0 END )		AS count_completed
            FROM t_transportations
            WHERE status BETWEEN 11 AND 20
            GROUP BY cargo
        ),

        TransportStatuses2 AS (
            SELECT 
                cargo,
                MAX( status )		AS max_status
            FROM t_transportations
            GROUP BY cargo having MAX(status) = 10
        ),

        InvoicesData AS (
            SELECT 
                t.cargo,
                IsNull(JSON_QUERY((
                    SELECT 
                        (t2.id) AS guid,
                        (t2.cargo) AS cargo,
                        (t2.client) AS recipient,
                        u.name AS client,
                        t2.weight,
                        t2.volume,
                        CASE t2.status 
                            WHEN 11 THEN 'Заказано'
                            WHEN 12 THEN 'Принято' 
                            WHEN 13 THEN 'На погрузке'
                            WHEN 14 THEN 'Загружается'
                            WHEN 15 THEN 'Загружено'
                            WHEN 16 THEN 'В пути'
                            WHEN 17 THEN 'Доставлено'
                            WHEN 18 THEN 'Разгружается'
                            WHEN 19 THEN 'Разгружено'
                            WHEN 20 THEN 'Завершено'
                        END AS status,
                        t2.status AS status_code,
                        tr.name AS transport,
                        tr.load_capacity AS capacity,
                        ISNULL((
                            SELECT FORMAT(CAST(SUM(rating) * 1.0 / NULLIF(COUNT(CASE WHEN rating > 0 THEN 1 END), 0) AS NUMERIC(3, 2)), 'N2')
                            FROM t_transportations 
                            WHERE client = t2.client AND rating > 0
                        ), '0.00') AS rating,
                        t2.cost AS price,
                        -- Флаг, требует ли статус действия от заказчика (нечетные статусы)
                        CASE WHEN t2.status % 2 = 1 THEN 1 ELSE 0 END AS requires_action
                    FROM t_transportations t2
                    LEFT JOIN t_transport tr ON tr.id = t2.transport
                    LEFT JOIN t_users u ON u.id = t2.client
                    WHERE t2.cargo = t.cargo 
                    AND t2.status BETWEEN 11 AND 20
                    FOR JSON PATH
                )), JSON_ARRAY()) AS invoices_json
            FROM t_transportations t
            WHERE t.status BETWEEN 10 AND 20
            GROUP BY t.cargo
        )
        
        -- Build JSON response with completed cargos only
        SELECT @out = (
            SELECT 
                (c.id)									AS guid,
                c.name												AS name,
                ISNULL(c.description, '')							AS description,
                JSON_QUERY(c.from_address)							AS address,
                JSON_QUERY(c.to_address)							AS destiny,
                ISNULL(c.contact_phone, '')							AS phone,
                ISNULL(c.contact_name, '')							AS face,
                ISNULL(c.weight, 0)									AS weight,
                ISNULL(ts.total_weight, 0)							AS ordered_weight,
                ISNULL(c.volume, 0)									AS volume,
                ISNULL(c.price, 0)									AS price,
                ISNULL(c.cost, 0)									AS cost,
                ISNULL(c.advance, 0)								AS advance,
                ISNULL(c.insurance, 0)								AS insurance,
                ISNULL(FORMAT(c.pickup_date, 'yyyy-MM-dd'), '')		AS pickup_date,
                ISNULL(FORMAT(c.delivery_date, 'yyyy-MM-dd'), '')	AS delivery_date,
                
                -- Статус для завершенных грузов
                CASE
                    WHEN ts.count_completed = ts.total_invoices AND ts.total_invoices > 0 THEN 'Завершено'
                    ELSE 'Проблемы'
                END AS status,
                
                -- Код статуса для завершенных грузов
                CASE
                    WHEN ts.count_completed = ts.total_invoices AND ts.total_invoices > 0 THEN 20
                    ELSE 99
                END AS status_code,
                
                -- Завершенные грузы не требуют действий
                0 AS requires_action,

                ISNULL(id.invoices_json, JSON_ARRAY()) AS invoices
                
            FROM t_cargo c
                LEFT JOIN TransportStatuses1 ts		ON c.id = ts.cargo
                LEFT JOIN TransportStatuses2 ts1	ON c.id = ts1.cargo
                LEFT JOIN InvoicesData id			ON c.id = id.cargo
            WHERE c.client = @user 
                -- Только завершенные грузы: все накладные имеют статус 20
                AND ts.count_completed = ts.total_invoices 
                AND ts.total_invoices > 0
            FOR JSON PATH
        );
        
        -- If no data, return empty array
        IF @out IS NULL
            SET @out = '[]';
        
        SELECT '{"success": true, "data": ' + @out + '}' AS data;
        
    END TRY
    BEGIN CATCH
        SELECT '{"success": false, "message": "Server error: ' + ERROR_MESSAGE() + '"}' AS data;
    END CATCH
END;


-- ========== p_get_agreement_data ==========

CREATE PROCEDURE [dbo].[p_get_agreement_data]
    @json NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    
    BEGIN TRY
        -- Парсинг входных параметров
        DECLARE @token UNIQUEIDENTIFIER
        DECLARE @driverId UNIQUEIDENTIFIER
        DECLARE @cargoId UNIQUEIDENTIFIER
        DECLARE @customerId UNIQUEIDENTIFIER
        
        SELECT 
            @token		= CAST(JSON_VALUE(@json, '$.token') AS UNIQUEIDENTIFIER),
            @driverId	= CAST(JSON_VALUE(@json, '$.driverId') AS UNIQUEIDENTIFIER),
            @cargoId	= CAST(JSON_VALUE(@json, '$.cargoId') AS UNIQUEIDENTIFIER)
        
        -- Проверка обязательных параметров
        IF @token IS NULL OR @driverId IS NULL OR @cargoId IS NULL
        BEGIN
            SELECT '{"success": false, "message": "Не указаны обязательные параметры: token, driverId, cargoId"}' AS data
            RETURN
        END
        
        -- Получаем ID заказчика по токену
        SELECT @customerId = id FROM t_users WHERE token = @token
        
        IF @customerId IS NULL
        BEGIN
            SELECT '{"success": false, "message": "Неверный токен"}' AS data
            RETURN
        END
        
        -- Проверяем, что груз принадлежит заказчику
        IF NOT EXISTS (SELECT 1 FROM t_cargo WHERE id = @cargoId AND client = @customerId)
        BEGIN
            SELECT '{"success": false, "message": "Груз не найден или доступ запрещен"}' AS data
            RETURN
        END
        
        -- Формируем результат
        DECLARE @result NVARCHAR(MAX)
        
        SET @result = (
            SELECT 
                -- Основная информация
                c.code AS orderId,
                c.price AS agreedPrice,
                c.code AS contractId,
                FORMAT(GETDATE(), 'dd.MM.yyyy') AS contractDate,
                
                -- Данные исполнителя (водителя)
                JSON_QUERY((
                    SELECT 
                        ISNULL(p.name, '') AS companyName,
                        ISNULL(u.name, '') AS representative,
                        ISNULL(p.inn, '') AS tin,
                        ISNULL(p.address, '') AS address,
                        ISNULL(p.phone, '') AS phone,
                        ISNULL(p.email, '') AS email
                    FROM t_users u
                    LEFT JOIN t_company p ON p.client = u.id AND p.company_type = 1 -- тип "Перевозчик"
                    WHERE u.id = @driverId
                    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                )) AS performer,
                
                -- Данные заказчика
                JSON_QUERY((
                    SELECT 
                        ISNULL(cust.name, '') AS companyName,
                        ISNULL(u.name, '') AS representative,
                        ISNULL(cust.inn, '') AS tin,
                        ISNULL(cust.address, '') AS address,
                        ISNULL(cust.phone, '') AS phone,
                        ISNULL(cust.email, '') AS email
                    FROM t_users u
                    LEFT JOIN t_company cust ON cust.client = u.id AND cust.company_type = 0 -- тип "Заказчик"
                    WHERE u.id = @customerId
                    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                )) AS customer,
                
                -- Маршрут
                JSON_QUERY((
                    SELECT 
                        JSON_VALUE(c.from_address, '$.city') AS [from],
                        JSON_VALUE(c.to_address, '$.city') AS [to]
                    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                )) AS route,
                
                -- Даты
                JSON_QUERY((
                    SELECT 
                        FORMAT(c.pickup_date, 'dd.MM.yyyy') AS [start],
                        FORMAT(c.delivery_date, 'dd.MM.yyyy') AS [end]
                    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                )) AS dates,
                
                -- Данные груза
                JSON_QUERY((
                    SELECT 
                        ISNULL(c.weight, 0) AS weight,
                        ISNULL(c.volume, 0) AS volume
                    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                )) AS cargo,
                
                -- Данные оплаты
                JSON_QUERY((
                    SELECT 
                        ISNULL(c.price, 0) AS total,
                        ISNULL(c.advance, 0) AS prepayment,
                        CASE 
                            WHEN ISNULL(c.price, 0) > 0 
                            THEN ROUND((ISNULL(c.advance, 0) * 100.0 / c.price), 0)
                            ELSE 0 
                        END AS prepaymentPercent,
                        ISNULL(c.price, 0) - ISNULL(c.advance, 0) AS remaining
                    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                )) AS payment,
                
                -- Подпись исполнителя (водителя)
                JSON_QUERY((
                    SELECT 
                        ISNULL(u.name, '') AS name,
                        '' AS sign
                    FROM t_users u
                    WHERE u.id = @driverId
                    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                )) AS performerSignature,
                
                -- Подпись заказчика
                JSON_QUERY((
                    SELECT 
                        ISNULL(u.name, '') AS name,
                        '' AS sign
                    FROM t_users u
                    WHERE u.id = @customerId
                    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                )) AS customerSignature
                
            FROM t_cargo c
            WHERE c.id = @cargoId
            FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
        )
        
        -- Если данные не найдены
        IF @result IS NULL OR @result = ''
        BEGIN
            SELECT '{"success": false, "message": "Данные не найдены"}' AS data
            RETURN
        END
        
        -- Возвращаем успешный результат
        SELECT '{"success": true, "data": ' + @result + '}' AS data
        
    END TRY
    BEGIN CATCH
        DECLARE @error_message NVARCHAR(4000) = ERROR_MESSAGE()
        SELECT '{"success": false, "message": "Ошибка при получении данных: ' + REPLACE(@error_message, '"', '\"') + '"}' AS data
    END CATCH
END


-- ========== p_set_advance ==========


-- Процедура p_set_advance
CREATE PROCEDURE [dbo].[p_set_advance](@json VARCHAR(MAX))
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @token UNIQUEIDENTIFIER = CAST(JSON_VALUE(@json, '$.token') AS UNIQUEIDENTIFIER);
    DECLARE @cargo_id UNIQUEIDENTIFIER = CAST(JSON_VALUE(@json, '$.cargo_id') AS UNIQUEIDENTIFIER);
    DECLARE @advance DECIMAL(15,2) = CAST(JSON_VALUE(@json, '$.advance') AS DECIMAL(15,2));
    DECLARE @user_id UNIQUEIDENTIFIER = (SELECT id FROM t_users WHERE token = @token);
    
    IF @user_id IS NULL
    BEGIN
        SELECT '{"success": false, "message": "Invalid token"}' AS data;
        RETURN;
    END
    
    UPDATE t_cargo 
    SET advance = advance + @advance 
    WHERE id = @cargo_id AND client = @user_id;
    
    IF @@ROWCOUNT > 0
        SELECT '{"success": true, "message": "Advance updated"}' AS data;
    ELSE
        SELECT '{"success": false, "message": "Cargo not found or access denied"}' AS data;
END


-- ========== p_upd_cargo ==========


CREATE PROCEDURE [dbo].[p_upd_cargo]
    @json NVARCHAR(MAX) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        -- Если передан JSON с ID для удаления из upd_cargo
        IF @json IS NOT NULL AND ISJSON(@json) = 1
        BEGIN
            CREATE TABLE #ids_to_delete (
                id UNIQUEIDENTIFIER
            );

            INSERT INTO #ids_to_delete (id)
            SELECT TRY_CAST(id AS UNIQUEIDENTIFIER)
            FROM OPENJSON(@json)
            WITH (
                id UNIQUEIDENTIFIER '$.id'
            )
            WHERE TRY_CAST(id AS UNIQUEIDENTIFIER) IS NOT NULL;

            DELETE FROM [dbo].[upd_cargo]
            WHERE [id] IN (SELECT id FROM #ids_to_delete);
        END

        DECLARE @out NVARCHAR(MAX);

        SET @out = (
            SELECT 
                a.id,
                a.[code],
                a.[name] Наименование ,
                a.[to_address] АдресДоставки,
                a.[from_address] АдресПолучения,
                a.[weight]	Вес,
                a.[contact_phone] Телефон,
                c.id client,
                a.[price] Цена,
                a.[cost] СтоимостьГруза,
                a.[advance],
                a.[pickup_date] ДатаОтправки,
                a.[delivery_date] ДатаДоставки,
                a.[description] Описание,
                a.[contact_name] КонтактноеЛицо,
                a.[volume] Объем,
                a.[insurance],
                u.[action]
            FROM t_cargo a
				INNER JOIN upd_cargo u ON u.id = a.id
				inner join t_company c on c.client = a.client
            ORDER BY a.[pickup_date] DESC
            FOR JSON PATH
        );

        SELECT '{"success": true, "data": ' + ISNULL(@out, '[]') + '}' AS data;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT '{"success": false, "data": [] }' AS data;
    END CATCH
END
