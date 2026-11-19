/**
 * Нагрузочная проверка: жеребьёвка на 100 участников и поток входов (пункт ТЗ
 * «Эксплуатация», цифры идут в статью). Бота запускаем на BotTest с подменённым
 * HTTP-клиентом: ядро, БД и рассылка — настоящие, сеть не нужна.
 *
 * Запуск: npm run loadtest
 */
/* eslint-disable no-console -- вывод цифр в консоль и есть результат скрипта */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BotTest } from 'umbot/test';
import { createApp, IApp } from '../app';
import { readSettings } from '../config';
import { IUserRef } from '../core/types';

const PARTICIPANTS = 100;
const OWNER: IUserRef = { platform: 'telegram', userId: 'owner' };

/** Сколько сообщений реально ушло в API платформы: бот пишет через httpClient. */
let sent = 0;

function ok(): Promise<Response> {
    sent++;
    return Promise.resolve(Response.json({ ok: true, result: { message_id: sent } }));
}

/** Одна операция с измерением. */
async function measured(run: () => Promise<unknown>): Promise<number> {
    const start = performance.now();
    await run();
    return performance.now() - start;
}

function print(title: string, ms: number, detail = ''): void {
    console.log(`${title.padEnd(22)} ${ms.toFixed(0)} мс${detail}`);
}

/** Поток входов по одному — как в чатах в течение вечера. */
async function sequentialJoins(app: IApp, roomId: string): Promise<void> {
    const ms = await measured(async () => {
        for (let i = 0; i < PARTICIPANTS; i++) {
            await app.service.join(
                { platform: 'telegram', userId: `u${i}` },
                roomId,
                `Участник ${i}`,
                {},
            );
        }
    });
    print('Входы по одному:', ms, ` (${(ms / PARTICIPANTS).toFixed(1)} мс на вход)`);
}

/** Волна одновременных входов — ссылка попала в активный чат. */
async function waveJoins(app: IApp, roomId: string): Promise<void> {
    const ms = await measured(async () => {
        const results = await Promise.allSettled(
            Array.from({ length: PARTICIPANTS }, (_, i) =>
                app.service.join(
                    { platform: 'telegram', userId: `w${i}` },
                    roomId,
                    `Волна ${i}`,
                    {},
                ),
            ),
        );
        const rejected = results.filter((r) => r.status === 'rejected');
        if (rejected.length) {
            console.log(`  отказов в волне: ${rejected.length}`);
        }
    });
    const count = (await app.service.store.participantsOf(roomId)).length;
    print('Входы волной:', ms, `, в комнате ${count} из ${PARTICIPANTS}`);
}

/** Жеребьёвка со списком на 100 пар и рассылкой результатов (bot.send подменён). */
async function drawWithDispatch(app: IApp, roomId: string): Promise<void> {
    sent = 0;
    const ms = await measured(async () => {
        const outcome = await app.service.runAction(OWNER, roomId, 'draw', {});
        // В живом боте рассылку после ответа на вебхук запускает dispatch()
        await app.notifier.deliver(
            outcome.room,
            outcome.outgoing,
            app.service.markDelivery.bind(app.service),
        );
        await app.notifier.whenIdle();
        if (outcome.room.status !== 'closed') {
            throw new Error('Жеребьёвка не прошла');
        }
    });
    const participants = await app.service.store.participantsOf(roomId);
    const pairs = participants.filter((p) => p.recipientId).length;
    const selfGifts = participants.filter((p) => p.recipientId === p.id).length;
    print('Жеребьёвка+рассылка:', ms, `, ${sent} сообщений, пар ${pairs}, себе ${selfGifts}`);
}

async function main(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'rooms-load-'));
    const bot = new BotTest();
    const app = createApp(
        { ...readSettings(), host: '127.0.0.1', port: 0, sendDelayMs: 0, sqliteFile: ':memory:' },
        { bot },
    );
    bot.setAppConfig({ json: dir, error_log: dir, tokens: { telegram: { token: 'load:test' } } });
    bot.setLogger({ log: () => undefined, warn: () => undefined, error: () => undefined });
    bot.getAppContext().httpClient = ok;

    // Вне обработки запросов подключение к БД открывается явно (как в задачах cron)
    if (!(await bot.connect())) {
        throw new Error('Не удалось подключиться к базе данных');
    }

    console.log(
        `Нагрузочная проверка: ${PARTICIPANTS} участников, SQLite в памяти, ${process.version}`,
    );
    console.log('');

    const room = await app.service.createRoom(
        OWNER,
        app.service.modes.get('santa'),
        'Нагрузка',
        {},
    );
    await sequentialJoins(app, room.id);

    const waveRoom = await app.service.createRoom(
        OWNER,
        app.service.modes.get('santa'),
        'Волна',
        {},
    );
    await waveJoins(app, waveRoom.id);

    await drawWithDispatch(app, room.id);

    const cleanup = await measured(() => app.service.cleanupExpired());
    print('Cleanup:', cleanup);

    await app.bot.close();
    rmSync(dir, { recursive: true, force: true });
}

main().catch((e: unknown) => {
    console.error('Нагрузочная проверка не прошла:', e instanceof Error ? e.message : e);
    process.exit(1);
});
