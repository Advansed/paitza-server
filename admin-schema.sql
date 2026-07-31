-- Admin panel: platform managers + bootstrap super-admin user
-- user_type: 9 = admin, 3 = manager (existing)

IF OBJECT_ID(N'dbo.t_platform_managers', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.t_platform_managers (
        id UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_t_platform_managers PRIMARY KEY DEFAULT NEWID(),
        name NVARCHAR(255) NOT NULL,
        phone VARCHAR(24) NOT NULL,
        email NVARCHAR(255) NULL,
        user_id UNIQUEIDENTIFIER NULL,
        is_active BIT NOT NULL CONSTRAINT DF_t_platform_managers_is_active DEFAULT (1),
        created_by UNIQUEIDENTIFIER NULL,
        created_at DATETIME NOT NULL CONSTRAINT DF_t_platform_managers_created_at DEFAULT (GETDATE()),
        updated_at DATETIME NULL
    );

    CREATE UNIQUE INDEX UX_t_platform_managers_phone ON dbo.t_platform_managers (phone);
END
GO

IF OBJECT_ID(N'dbo.p_admin_is_admin', N'FN') IS NOT NULL
    DROP FUNCTION dbo.p_admin_is_admin;
GO

CREATE FUNCTION dbo.p_admin_is_admin(@token UNIQUEIDENTIFIER)
RETURNS UNIQUEIDENTIFIER
AS
BEGIN
    DECLARE @admin_id UNIQUEIDENTIFIER;

    SELECT @admin_id = id
    FROM dbo.t_users
    WHERE token = @token AND user_type = 9;

    RETURN @admin_id;
END
GO

IF OBJECT_ID(N'dbo.p_admin_get_managers', N'P') IS NOT NULL
    DROP PROCEDURE dbo.p_admin_get_managers;
GO

CREATE PROCEDURE dbo.p_admin_get_managers(@json NVARCHAR(MAX))
AS
BEGIN
    SET NOCOUNT ON;

    BEGIN TRY
        IF (ISJSON(@json) = 0)
        BEGIN
            SELECT '{"success": false, "message": "Неверный json"}' AS data;
            RETURN;
        END

        DECLARE @token UNIQUEIDENTIFIER = TRY_CAST(JSON_VALUE(@json, '$.token') AS UNIQUEIDENTIFIER);
        DECLARE @admin_id UNIQUEIDENTIFIER = dbo.p_admin_is_admin(@token);

        IF (@admin_id IS NULL)
        BEGIN
            SELECT '{"success": false, "message": "Доступ запрещён"}' AS data;
            RETURN;
        END

        DECLARE @out NVARCHAR(MAX) = (
            SELECT
                CAST(m.id AS NVARCHAR(36)) AS id,
                m.name,
                m.phone,
                ISNULL(m.email, '') AS email,
                CAST(m.is_active AS BIT) AS is_active,
                FORMAT(m.created_at, 'yyyy-MM-dd HH:mm:ss') AS created_at,
                CAST(m.user_id AS NVARCHAR(36)) AS user_id
            FROM dbo.t_platform_managers m
            ORDER BY m.created_at DESC
            FOR JSON PATH
        );

        SELECT '{"success": true, "data": ' + ISNULL(@out, '[]') + '}' AS data;
    END TRY
    BEGIN CATCH
        SELECT '{"success": false, "message": "Ошибка сервера: ' + ERROR_MESSAGE() + '"}' AS data;
    END CATCH
END
GO

IF OBJECT_ID(N'dbo.p_admin_add_manager', N'P') IS NOT NULL
    DROP PROCEDURE dbo.p_admin_add_manager;
GO

CREATE PROCEDURE dbo.p_admin_add_manager(@json NVARCHAR(MAX))
AS
BEGIN
    SET NOCOUNT ON;

    BEGIN TRY
        IF (ISJSON(@json) = 0)
        BEGIN
            SELECT '{"success": false, "message": "Неверный json"}' AS data;
            RETURN;
        END

        DECLARE @token UNIQUEIDENTIFIER = TRY_CAST(JSON_VALUE(@json, '$.token') AS UNIQUEIDENTIFIER);
        DECLARE @admin_id UNIQUEIDENTIFIER = dbo.p_admin_is_admin(@token);

        IF (@admin_id IS NULL)
        BEGIN
            SELECT '{"success": false, "message": "Доступ запрещён"}' AS data;
            RETURN;
        END

        DECLARE @name NVARCHAR(255) = LTRIM(RTRIM(JSON_VALUE(@json, '$.name')));
        DECLARE @phone_raw VARCHAR(32) = JSON_VALUE(@json, '$.phone');
        DECLARE @phone VARCHAR(24) = dbo.getPhone(@phone_raw);
        DECLARE @email NVARCHAR(255) = LTRIM(RTRIM(JSON_VALUE(@json, '$.email')));
        DECLARE @password VARCHAR(64) = ISNULL(NULLIF(LTRIM(RTRIM(JSON_VALUE(@json, '$.password'))), ''), 'manager');

        IF (@name IS NULL OR @name = '' OR @phone IS NULL OR @phone = '')
        BEGIN
            SELECT '{"success": false, "message": "Укажите имя и телефон менеджера"}' AS data;
            RETURN;
        END

        IF EXISTS (SELECT 1 FROM dbo.t_platform_managers WHERE phone = @phone)
        BEGIN
            SELECT '{"success": false, "message": "Менеджер с таким телефоном уже существует"}' AS data;
            RETURN;
        END

        DECLARE @manager_id UNIQUEIDENTIFIER = NEWID();
        DECLARE @user_id UNIQUEIDENTIFIER = NULL;

        IF NOT EXISTS (SELECT 1 FROM dbo.t_users WHERE code = @phone)
        BEGIN
            SET @user_id = NEWID();

            INSERT INTO dbo.t_users (
                id, code, name, email, partner, password, token, image, user_type, description,
                email_enabled, sms_enabled, orders_enabled, market_enabled, orders, rating, paid, pincode, gender, account
            )
            VALUES (
                @user_id,
                @phone,
                @name,
                ISNULL(@email, ''),
                '00000000-0000-0000-0000-000000000000',
                @password,
                NEWID(),
                '',
                3,
                '',
                0, 0, 0, 0,
                0, 0, 0,
                NULL,
                1,
                0
            );
        END
        ELSE
        BEGIN
            SELECT @user_id = id FROM dbo.t_users WHERE code = @phone;

            UPDATE dbo.t_users
            SET name = @name,
                email = CASE WHEN @email <> '' THEN @email ELSE email END,
                user_type = 3
            WHERE id = @user_id;
        END

        INSERT INTO dbo.t_platform_managers (id, name, phone, email, user_id, created_by)
        VALUES (@manager_id, @name, @phone, NULLIF(@email, ''), @user_id, @admin_id);

        SELECT '{"success": true, "message": "Менеджер добавлен", "guid": "' + CAST(@manager_id AS NVARCHAR(36)) + '"}' AS data;
    END TRY
    BEGIN CATCH
        SELECT '{"success": false, "message": "Ошибка сервера: ' + ERROR_MESSAGE() + '"}' AS data;
    END CATCH
END
GO

IF OBJECT_ID(N'dbo.p_admin_set_manager_active', N'P') IS NOT NULL
    DROP PROCEDURE dbo.p_admin_set_manager_active;
GO

CREATE PROCEDURE dbo.p_admin_set_manager_active(@json NVARCHAR(MAX))
AS
BEGIN
    SET NOCOUNT ON;

    BEGIN TRY
        IF (ISJSON(@json) = 0)
        BEGIN
            SELECT '{"success": false, "message": "Неверный json"}' AS data;
            RETURN;
        END

        DECLARE @token UNIQUEIDENTIFIER = TRY_CAST(JSON_VALUE(@json, '$.token') AS UNIQUEIDENTIFIER);
        DECLARE @admin_id UNIQUEIDENTIFIER = dbo.p_admin_is_admin(@token);

        IF (@admin_id IS NULL)
        BEGIN
            SELECT '{"success": false, "message": "Доступ запрещён"}' AS data;
            RETURN;
        END

        DECLARE @manager_id UNIQUEIDENTIFIER = TRY_CAST(JSON_VALUE(@json, '$.id') AS UNIQUEIDENTIFIER);
        DECLARE @is_active BIT = TRY_CAST(JSON_VALUE(@json, '$.is_active') AS BIT);

        IF (@manager_id IS NULL OR @is_active IS NULL)
        BEGIN
            SELECT '{"success": false, "message": "Укажите id и is_active"}' AS data;
            RETURN;
        END

        UPDATE dbo.t_platform_managers
        SET is_active = @is_active,
            updated_at = GETDATE()
        WHERE id = @manager_id;

        IF (@@ROWCOUNT = 0)
        BEGIN
            SELECT '{"success": false, "message": "Менеджер не найден"}' AS data;
            RETURN;
        END

        SELECT '{"success": true, "message": "Статус менеджера обновлён"}' AS data;
    END TRY
    BEGIN CATCH
        SELECT '{"success": false, "message": "Ошибка сервера: ' + ERROR_MESSAGE() + '"}' AS data;
    END CATCH
END
GO

-- Bootstrap super-admin: 89141088848, password: admin
DECLARE @admin_phone VARCHAR(24) = dbo.getPhone('89141088848');
DECLARE @admin_id UNIQUEIDENTIFIER;

IF NOT EXISTS (SELECT 1 FROM dbo.t_users WHERE code = @admin_phone)
BEGIN
    SET @admin_id = NEWID();

    INSERT INTO dbo.t_users (
        id, code, name, email, partner, password, token, image, user_type, description,
        email_enabled, sms_enabled, orders_enabled, market_enabled, orders, rating, paid, pincode, gender, account
    )
    VALUES (
        @admin_id,
        @admin_phone,
        N'Администратор',
        'admin@gruzreis.ru',
        '00000000-0000-0000-0000-000000000000',
        'admin',
        NEWID(),
        '',
        9,
        '',
        0, 0, 0, 0,
        0, 0, 0,
        NULL,
        1,
        0
    );
END
ELSE
BEGIN
    UPDATE dbo.t_users
    SET user_type = 9,
        password = CASE WHEN password IS NULL OR password = '' THEN 'admin' ELSE password END,
        name = CASE WHEN name IS NULL OR name = '' THEN N'Администратор' ELSE name END
    WHERE code = @admin_phone;
END
GO
