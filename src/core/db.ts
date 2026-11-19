import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { IAppDB, IDbTableSchema } from 'umbot';
import { FileAdapter } from 'umbot/plugins';
import { KnexAdapter } from 'umbot-knex-adapter';

const ID = { type: 'string', maxLength: 16 } as const;
const DATE = { type: 'string', maxLength: 32 } as const;
const JSON_TEXT = { type: 'text' } as const;

/**
 * Таблицы бота — общие для всех режимов: данные режима лежат в JSON-полях
 * rooms.settings, participants.profile и в marks. Новому режиму новые таблицы не нужны.
 * Описание — единственный источник правды: по нему строятся модели (core/models.ts)
 * и создаются таблицы в базе.
 */
export const TABLES = {
    rooms: {
        tableName: 'rooms',
        primaryKeyName: 'id',
        uniqueKeys: [],
        fields: {
            id: ID,
            code: { type: 'string', maxLength: 8 },
            mode: { type: 'string', maxLength: 32 },
            title: { type: 'string', maxLength: 60 },
            settings: JSON_TEXT,
            ownerPlatform: { type: 'string', maxLength: 32 },
            ownerUserId: { type: 'string', maxLength: 250 },
            status: { type: 'string', maxLength: 16 },
            timezone: { type: 'string', maxLength: 64 },
            createdAt: DATE,
            closedAt: DATE,
            expiresAt: DATE,
            nextRunAt: DATE,
        },
        indexes: [['code'], ['ownerPlatform', 'ownerUserId'], ['status'], ['nextRunAt']],
    },
    participants: {
        tableName: 'participants',
        primaryKeyName: 'id',
        uniqueKeys: [],
        fields: {
            id: ID,
            roomId: ID,
            platform: { type: 'string', maxLength: 32 },
            userId: { type: 'string', maxLength: 250 },
            name: { type: 'string', maxLength: 40 },
            profile: JSON_TEXT,
            recipientId: ID,
            delivery: { type: 'string', maxLength: 16 },
            joinedAt: DATE,
        },
        indexes: [['roomId'], ['platform', 'userId']],
    },
    marks: {
        tableName: 'marks',
        primaryKeyName: 'id',
        uniqueKeys: [],
        fields: {
            // id = participantId:key — одна отметка с этим ключом на участника
            id: { type: 'string', maxLength: 120 },
            roomId: ID,
            participantId: ID,
            key: { type: 'string', maxLength: 100 },
            value: { type: 'string', maxLength: 250 },
            createdAt: DATE,
        },
        indexes: [['roomId', 'key'], ['participantId']],
    },
    relays: {
        tableName: 'relays',
        primaryKeyName: 'id',
        uniqueKeys: [],
        fields: {
            id: ID,
            roomId: ID,
            fromId: ID,
            toId: ID,
            text: JSON_TEXT,
            deliverAt: DATE,
            status: { type: 'string', maxLength: 16 },
            createdAt: DATE,
        },
        indexes: [['roomId'], ['status'], ['deliverAt']],
    },
    blocks: {
        tableName: 'blocks',
        primaryKeyName: 'id',
        uniqueKeys: [],
        fields: {
            id: { type: 'string', maxLength: 40 },
            roomId: ID,
            blockerId: ID,
            blockedId: ID,
        },
        indexes: [['roomId'], ['blockerId']],
    },
    sendLog: {
        tableName: 'sendLog',
        primaryKeyName: 'key',
        uniqueKeys: [],
        // roomId — чтобы стереть журнал вместе с комнатой: по префиксу ключа БД umbot искать не умеет
        fields: { key: { type: 'string', maxLength: 200 }, roomId: ID, sentAt: DATE },
        indexes: [['roomId']],
    },
    locks: {
        tableName: 'locks',
        primaryKeyName: 'key',
        uniqueKeys: [],
        fields: {
            key: { type: 'string', maxLength: 64 },
            owner: { type: 'string', maxLength: 64 },
            expiresAt: DATE,
        },
        indexes: [],
    },
} as const satisfies Record<string, IDbTableSchema>;

/** Описание одной из таблиц бота. */
export type TTableSchema = (typeof TABLES)[keyof typeof TABLES];

/** Какую БД использовать: файловая — для разработки, SQLite — для продакшена. */
export interface IDbOptions {
    /** Путь к файлу SQLite. Не задан — файловая БД umbot в папке json */
    sqliteFile?: string | undefined;
}

/**
 * Создаёт DB-адаптер и конфигурацию подключения к нему.
 *
 * @param options Настройки БД
 * @returns Адаптер и поле db для setAppConfig()
 *
 * @example
 * ```ts
 * const { adapter, db } = createDbAdapter({ sqliteFile: './data/bot.sqlite' });
 * bot.use(adapter).setAppConfig({ db });
 * ```
 */
export function createDbAdapter(options: IDbOptions): {
    adapter: FileAdapter | KnexAdapter;
    db: IAppDB | undefined;
} {
    if (!options.sqliteFile) {
        return { adapter: new FileAdapter(), db: undefined };
    }
    // SQLite создаёт файл базы, но не папку для него
    if (options.sqliteFile !== ':memory:') {
        mkdirSync(dirname(options.sqliteFile), { recursive: true });
    }
    const db: IAppDB = {
        host: '',
        database: options.sqliteFile,
        options: { client: 'better-sqlite3' },
    };
    // О занятости базы (бот + задачи cron): knex-диалект better-sqlite3 передаёт
    // драйверу только nativeBinding/readonly, поэтому явный busy_timeout не задать —
    // действует дефолт better-sqlite3: ждать освобождения до 5 с, затем ошибка.
    // Ошибку адаптер превращает в false — операция «мягко» не удаётся, RoomLock и
    // рассылки это переживают (ретрай или повтор на следующем тике).
    return { adapter: new KnexAdapter(db), db };
}
