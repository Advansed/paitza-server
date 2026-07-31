const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

/**
 * Сервис проверки российского паспорта через Google Gemini (vision).
 * Две процедуры:
 *  - verifyPassportPhoto        — разворот с фото (основные данные)
 *  - verifyPassportRegistration — страница прописки
 */
class PassportVerificationService {
    constructor(apiKey = process.env.GEMINI_API_KEY) {
        if (!apiKey) {
            console.warn('⚠️ GEMINI_API_KEY не задан — проверка паспорта недоступна');
        }
        this.genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
    }

    _getModel() {
        if (!this.genAI) {
            throw new Error('GEMINI_API_KEY не настроен');
        }
        return this.genAI.getGenerativeModel({
            model: MODEL,
            generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json',
            },
        });
    }

    /**
     * Нормализация изображения: data URL или чистый base64 → { data, mimeType }
     */
    _normalizeImage(image, mimeType = 'image/jpeg') {
        if (!image || typeof image !== 'string') {
            throw new Error('Изображение обязательно (base64 или data URL)');
        }

        let data = image.trim();
        let type = mimeType;

        const dataUrlMatch = data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
        if (dataUrlMatch) {
            type = dataUrlMatch[1];
            data = dataUrlMatch[2];
        } else if (data.includes(',')) {
            // на случай обрезанного data: префикса
            data = data.split(',').pop();
        }

        data = data.replace(/\s/g, '');
        if (!data) {
            throw new Error('Пустые данные изображения');
        }

        return { data, mimeType: type };
    }

    _parseJson(text) {
        if (!text) {
            throw new Error('Пустой ответ модели');
        }

        const cleaned = text
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        try {
            return JSON.parse(cleaned);
        } catch (e) {
            const start = cleaned.indexOf('{');
            const end = cleaned.lastIndexOf('}');
            if (start >= 0 && end > start) {
                return JSON.parse(cleaned.slice(start, end + 1));
            }
            throw new Error('Не удалось разобрать JSON ответа Gemini: ' + e.message);
        }
    }

    async _generate(prompt, imageInput, mimeType) {
        const model = this._getModel();
        const image = this._normalizeImage(imageInput, mimeType);

        const result = await model.generateContent([
            { text: prompt },
            {
                inlineData: {
                    mimeType: image.mimeType,
                    data: image.data,
                },
            },
        ]);

        const text = result.response.text();
        return this._parseJson(text);
    }

    /**
     * Процедура 1: проверка разворота паспорта с фото.
     * @param {string} image - base64 или data URL
     * @param {object} [options]
     * @param {string} [options.mimeType]
     * @param {object} [options.expected] - ожидаемые поля для сверки (опционально)
     */
    async verifyPassportPhoto(image, options = {}) {
        const expectedHint = options.expected
            ? `\nОжидаемые данные клиента (для сверки, если переданы): ${JSON.stringify(options.expected)}`
            : '';

        const prompt = `Ты — сервис KYC. На изображении — разворот российского паспорта РФ с фотографией владельца (страницы 2–3).

                Задачи:
                1. Убедись, что это именно паспорт РФ с фото, а не другой документ / скрин / чужая страница.
                2. Распознай все читаемые поля.
                3. Оцени читаемость и подозрительные признаки (размытие, обрезка, явный монтаж).

                Верни ТОЛЬКО JSON без пояснений:
                {
                "success": true|false,
                "is_passport_photo_page": true|false,
                "readable": true|false,
                "confidence": 0.0-1.0,
                "fields": {
                    "series": "строка или null",
                    "number": "строка или null",
                    "last_name": "строка или null",
                    "first_name": "строка или null",
                    "patronymic": "строка или null",
                    "gender": "M"|"F"|null,
                    "birth_date": "ДД.ММ.ГГГГ или null",
                    "birth_place": "строка или null",
                    "issued_by": "строка или null",
                    "issue_date": "ДД.ММ.ГГГГ или null",
                    "department_code": "XXX-XXX или null"
                },
                "has_photo": true|false,
                "issues": ["краткие замечания"],
                "summary": "краткий вывод на русском"
                }
                ${expectedHint}
                Если документ не подходит или поля почти не читаются — success=false и опиши issues.`;

        try {
            const data = await this._generate(prompt, image, options.mimeType);
            return {
                success: Boolean(data.success),
                type: 'passport_photo',
                ...data,
            };
        } catch (error) {
            console.error('❌ verifyPassportPhoto:', error.message);
            return {
                success: false,
                type: 'passport_photo',
                message: error.message,
                issues: [error.message],
            };
        }
    }

    /**
     * Процедура 2: проверка страницы прописки.
     * @param {string} image - base64 или data URL
     * @param {object} [options]
     * @param {string} [options.mimeType]
     * @param {object} [options.expected] - ожидаемый адрес и т.п.
     */
    async verifyPassportRegistration(image, options = {}) {
        const expectedHint = options.expected
            ? `\nОжидаемые данные прописки (для сверки, если переданы): ${JSON.stringify(options.expected)}`
            : '';

        const prompt = `Ты — сервис KYC. На изображении — страница российского паспорта РФ с регистрацией по месту жительства (прописка), обычно страница 5 и далее со штампами.

            Задачи:
            1. Убедись, что это страница прописки паспорта РФ (штампы регистрации), а не разворот с фото и не другой документ.
            2. Распознай актуальную (последнюю по дате, если их несколько) регистрацию.
            3. Оцени читаемость штампа и подозрительные признаки.

            Верни ТОЛЬКО JSON без пояснений:
            {
            "success": true|false,
            "is_registration_page": true|false,
            "readable": true|false,
            "confidence": 0.0-1.0,
            "fields": {
                "registration_type": "постоянная"|"временная"|null,
                "registration_date": "ДД.ММ.ГГГГ или null",
                "region": "строка или null",
                "city": "строка или null",
                "street": "строка или null",
                "house": "строка или null",
                "building": "строка или null",
                "apartment": "строка или null",
                "full_address": "полный адрес одной строкой или null",
                "authority": "орган, поставивший штамп, или null"
            },
            "stamps_count": 0,
            "issues": ["краткие замечания"],
            "summary": "краткий вывод на русском"
            }
            ${expectedHint}
            Если это не страница прописки или штамп нечитаем — success=false и опиши issues.`;

        try {
            const data = await this._generate(prompt, image, options.mimeType);
            return {
                success: Boolean(data.success),
                type: 'passport_registration',
                ...data,
            };
        } catch (error) {
            console.error('❌ verifyPassportRegistration:', error.message);
            return {
                success: false,
                type: 'passport_registration',
                message: error.message,
                issues: [error.message],
            };
        }
    }
}

module.exports = PassportVerificationService;
module.exports.PassportVerificationService = PassportVerificationService;
