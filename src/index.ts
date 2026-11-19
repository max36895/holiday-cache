import { createApp } from './app';
import { readSettings } from './config';
import { BotTest } from 'umbot/test';

const settings = readSettings();
const app = createApp(settings);
app.bot.setAppMode('strict_prod');
const appContext = app.bot.getAppContext();
if (!settings.sqliteFile) {
    appContext.logWarn(
        'SQLITE_FILE не задан: данные хранятся в файловой БД umbot (только для разработки).',
    );
}
if (!settings.privacyUrl) {
    appContext.logWarn(
        'PRIVACY_POLICY_URL не задан: ссылки на политику конфиденциальности не будет.',
    );
}
if (!settings.tgWorkerUrl) {
    appContext.logWarn(
        'TG_WORKER_URL не задан: запросы к Telegram API идут напрямую. Если сеть хостинга не пускает к api.telegram.org, задайте relay-воркер.',
    );
}
// Ошибка вне обработки запроса пишется в лог, процесс продолжает работать
process.on('unhandledRejection', (reason) => {
    appContext.logError('Необработанная ошибка', {
        error:
            reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason),
    });
});
// Остановка (деплой, Ctrl+C): дождаться фоновой рассылки, чтобы сообщения не потерялись
let closing = false;
const shutdown = (signal: string): void => {
    if (closing) {
        return;
    }
    closing = true;
    appContext.log(`${signal}: дожидаемся рассылки и закрываемся`);
    void app.notifier
        .whenIdle()
        .then(() => app.bot.close())
        .catch((e: unknown) => {
            appContext.logError('Не удалось закрыться чисто', {
                error: e instanceof Error ? e.message : String(e),
            });
        })
        .finally(() => process.exit(0));
    // Страховка: не висим дольше 10 секунд, даже если рассылка застряла
    setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
if (settings.isDev) {
    app.bot.appType = 'alisa';
    void (app.bot as BotTest).test({
        isShowResult: true,
        isShowTime: true,
    });
}
app.bot.start(settings.host, settings.port);
