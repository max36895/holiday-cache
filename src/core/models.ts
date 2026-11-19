import { AppContext, IModelRes, IModelRules, IModelState, IQueryData, Model } from 'umbot';
import { TTableSchema } from './db';

/** Строка таблицы: все поля — строки или null (JSON и даты хранятся строкой). */
export type TRow = Record<string, string | null>;

/**
 * Класс модели umbot для таблицы из описания TABLES: tableName(), rules()
 * и attributeLabels() строятся по полям схемы, поэтому модель и таблица в базе
 * не расходятся.
 */
function modelClass(
    schema: TTableSchema,
    keyFields: readonly string[],
): new (appContext: AppContext) => Model<IModelState> {
    const rules: IModelRules[] = Object.entries(schema.fields).map(([name, field]) =>
        field.type === 'text'
            ? { name: [name], type: 'text' }
            : { name: [name], type: 'string', max: field.maxLength },
    );
    // Первичный ключ umbot находит по метке 'ID'
    const labels = Object.fromEntries(
        Object.keys(schema.fields).map((name) => [
            name,
            name === schema.primaryKeyName ? 'ID' : name,
        ]),
    );
    return class TableModel extends Model<IModelState> {
        constructor(appContext: AppContext) {
            super(appContext);
        }

        tableName(): string {
            return schema.tableName;
        }

        rules(): IModelRules[] {
            return rules;
        }

        attributeLabels(): IModelState {
            return labels;
        }

        protected override getUniqueKeys(): string[] {
            return [...keyFields];
        }
    };
}

/**
 * Строки результата выборки. Пустая выборка у адаптеров umbot — status: false
 * (файловая БД при этом ещё и пишет error), поэтому оба случая — пустой массив.
 */
function rowsOf(res: IModelRes): TRow[] {
    if (!res.status || !res.data) {
        return [];
    }
    const data = Array.isArray(res.data) ? res.data : [res.data];
    return data.filter((row): row is TRow => typeof row === 'object' && row !== null);
}

/**
 * Таблица: выборка по равенству полей и запись строки целиком.
 * Строка пишется целиком, а не частично: файловая БД при частичной записи
 * затирает недостающие поля. Целостность обеспечивает блокировка комнаты (RoomLock).
 *
 * @example
 * ```ts
 * const rooms = new Table(appContext, TABLES.rooms);
 * const found = await rooms.select({ code: 'K7M2QX' });
 * ```
 */
export class Table {
    readonly #appContext: AppContext;
    readonly #Model: new (appContext: AppContext) => Model<IModelState>;

    /**
     * @param appContext Контекст приложения
     * @param schema Описание таблицы из TABLES
     * @param keyFields Поля, которые вместе с первичным ключом входят в условие
     *   update/remove: удаление сработает, только если они не изменились
     */
    constructor(appContext: AppContext, schema: TTableSchema, keyFields: readonly string[] = []) {
        this.#appContext = appContext;
        this.#Model = modelClass(schema, keyFields);
    }

    /**
     * Строки, у которых все поля where равны заданным значениям.
     *
     * @param where Условие: точное равенство полей
     * @returns Найденные строки
     */
    async select(where: IQueryData): Promise<TRow[]> {
        return rowsOf(await new this.#Model(this.#appContext).where(where));
    }

    async #write(row: TRow, op: 'add' | 'update' | 'remove'): Promise<boolean> {
        const model = new this.#Model(this.#appContext);
        model.state = { ...row };
        return model[op]();
    }

    /**
     * Добавляет строку.
     *
     * @param row Строка со всеми полями
     * @returns false, если запись не удалась (в SQL — в том числе занятый первичный ключ)
     */
    insert(row: TRow): Promise<boolean> {
        return this.#write(row, 'add');
    }

    /**
     * Перезаписывает строку по первичному ключу.
     *
     * @param row Строка со всеми полями
     * @throws Error, если запись не удалась
     */
    async update(row: TRow): Promise<void> {
        if (!(await this.#write(row, 'update'))) {
            throw new Error('Не удалось обновить запись в базе данных');
        }
    }

    /**
     * Удаляет строку по первичному ключу.
     *
     * @param row Строка (нужен первичный ключ)
     * @throws Error, если удаление не удалось
     */
    async remove(row: TRow): Promise<void> {
        if (!(await this.#write(row, 'remove'))) {
            throw new Error('Не удалось удалить запись из базы данных');
        }
    }
}
