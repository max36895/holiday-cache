import { createApp, IApp } from '../app';
import { readSettings } from '../config';

/**
 * Запускает задачу cron: собирает бота без HTTP-сервера, подключается к БД
 * (bot.connect() создаёт и встроенные таблицы umbot, и таблицы бота),
 * выполняет job и закрывает соединения. Ошибка — код выхода 1 для cron.
 *
 * @param name Имя задачи для лога
 * @param job Задача
 */
export function runJob(name: string, job: (app: IApp) => Promise<string>): void {
    const app = createApp(readSettings());
    const appContext = app.bot.getAppContext();
    app.bot
        .connect()
        .then(async (connected) => {
            if (!connected) {
                throw new Error('Не удалось подключиться к базе данных');
            }
            const summary = await job(app);
            await app.notifier.whenIdle();
            appContext.log(`${name}: ${summary}`);
            // close() закрывает и подключение к БД, открытое connect()
            await app.bot.close();
        })
        .catch((e: unknown) => {
            console.error(`${name} не выполнен:`, e instanceof Error ? e.message : e);
            process.exit(1);
        });
}
