import { Bot, BotController } from 'umbot';
import { T } from '../texts';
import { A, addButtons, btn } from '../ui';
import { IDeps, IGameUserData, MENU_BUTTONS } from './context';
import { registerJoin } from './join';
import { registerMenu } from './menu';
import { registerRelay } from './relay';
import { registerRoomActions } from './room';
import { registerWizard } from './wizard';

/**
 * Контроллер бота. Вся логика — в командах, шагах и действиях кнопок
 * (registerGame); action() только страхует ответ, если обработчик ничего не написал.
 */
export class GameController extends BotController<IGameUserData> {
    public action(): void {
        if (!this.text) {
            const current = this.userData.currentRoomId;
            this.text = current ? T.notUnderstoodInGame : T.notUnderstood;
            addButtons(
                this.buttons,
                current
                    ? [btn('Текущая игра', A.room, { r: current }), ...MENU_BUTTONS]
                    : MENU_BUTTONS,
            );
        }
    }
}

/**
 * Подключает к боту все диалоги. Ядро и контроллер знают только IMode и реестр
 * режимов: правила игр — в modes/.
 *
 * @param bot Бот
 * @param deps Зависимости обработчиков
 */
export function registerGame(bot: Bot, deps: IDeps): void {
    bot.initBotController(GameController);
    registerMenu(bot, deps);
    registerWizard(bot, deps);
    registerJoin(bot, deps);
    registerRoomActions(bot, deps);
    registerRelay(bot, deps);
}
