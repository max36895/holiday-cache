import { IMode } from './IMode';
import { SantaMode } from './santa/SantaMode';
import { BirthdayMode } from './birthdays/BirthdayMode';
import { ValentineMode } from './valentines/ValentineMode';
import { GiftMode } from './gift/GiftMode';
import { MeetingMode } from './meeting/MeetingMode';

/**
 * Включённые режимы. Новый режим — папка в modes/ и строка здесь.
 * [Создать игру] показывает меню выбора, когда режимов больше одного.
 */
export const MODES: readonly IMode[] = [
    SantaMode,
    BirthdayMode,
    ValentineMode,
    GiftMode,
    MeetingMode,
];
