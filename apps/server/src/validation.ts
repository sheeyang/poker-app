import { isSupportedStrategy } from '@poker/strategies';
import { actionTimeLimits, defaultConfiguration, type ApplicationRejection, type CreateTableSessionRequest } from '@poker/contracts';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** The key by which two Participant names at one table are the same name, ignoring case. */
export const nameKey = (name: string) => name.normalize('NFC').toLowerCase();
/**
 * Every Participant's name, a Guest's display name or a Bot's: trimmed, 1-20 characters of letters, digits, spaces
 * and basic punctuation. Control, format and invisible characters are not letters, so no name can look like another.
 * `undefined` when the value is no such name.
 */
export function participantName(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value.trim() : '';
  const length = [...name].length;
  return length >= 1 && length <= 20 && /^[\p{L}\p{N} .,'’\-_!?()]+$/u.test(name) ? name : undefined;
}
/** What a rejected Participant name is told: the rules of `participantName`. */
export const participantNameRules = 'Use 1 to 20 letters, digits, spaces or basic punctuation (. , \' - _ ! ? and parentheses).';
export function validateDisplayName(value: unknown): { ok: true; displayName: string } | ApplicationRejection {
  const name = participantName(value);
  if (name === undefined) return { ok: false, rejection: { code: 'invalid-display-name', field: 'displayName', message: participantNameRules } };
  return { ok: true, displayName: name };
}
export function validateTrainerConfiguration(value: unknown, supportsStrategy: (descriptor: unknown) => boolean = isSupportedStrategy): ApplicationRejection | undefined {
  if (!object(value) || Object.keys(value).some(key => !['referenceStrategy', 'liveAnalysis'].includes(key)) || typeof value.liveAnalysis !== 'boolean')
    return { ok: false, rejection: { code: 'invalid-trainer-configuration', message: 'Supply a complete Reference Strategy and a boolean Live Analysis setting.' } };
  if (!supportsStrategy(value.referenceStrategy))
    return { ok: false, rejection: { code: 'unsupported-strategy', message: 'Choose a supported complete Reference Strategy.' } };
}
/** A non-empty partial set of the options an Online Table's owner can change. */
export function validateTableOptionChanges(value: unknown): ApplicationRejection | undefined {
  const reject = (field: string, message: string): ApplicationRejection => ({ ok: false, rejection: { code: 'invalid-table-options', field, message } });
  if (!object(value)) return reject('options', 'Supply the options to change as an object.');
  const names = Object.keys(value);
  if (names.length === 0) return reject('options', 'Name at least one option to change.');
  const unknown = names.find(name => !['actionTimeLimitSeconds', 'allowLiveAnalysis', 'allowSeatChanges'].includes(name));
  if (unknown) return reject(unknown, 'Only the Action Time Limit, Allow Live Analysis and seat changes can be changed.');
  if (value.actionTimeLimitSeconds !== undefined && !(actionTimeLimits as readonly unknown[]).includes(value.actionTimeLimitSeconds)) return reject('actionTimeLimitSeconds', 'Choose an Action Time Limit of 15, 30 or 60 seconds.');
  for (const name of ['allowLiveAnalysis', 'allowSeatChanges'] as const) if (value[name] !== undefined && typeof value[name] !== 'boolean') return reject(name, 'Choose on or off.');
}
export function validateCreationRequest(request: CreateTableSessionRequest, supportsStrategy: (descriptor: unknown) => boolean = isSupportedStrategy): ApplicationRejection | undefined {
  const reject = (field: string, message: string): ApplicationRejection => ({ ok: false, rejection: { code: 'invalid-creation-settings', field, message } });
  for (const key of Object.keys(request)) {
    if (!['requestId', 'mode', 'configuration', 'options', 'bots'].includes(key)) return reject(key, 'Creation accepts only a mode, observable configuration, table options and Bot controller intentions.');
  }
  if (request.mode !== undefined && request.mode !== 'practice' && request.mode !== 'online') return reject('mode', 'Choose a Practice Table or an Online Table.');
  if (request.options !== undefined) {
    const options = request.options as unknown;
    if (!object(options) || Object.keys(options).some(key => !['actionTimeLimitSeconds', 'allowLiveAnalysis'].includes(key))) return reject('options', 'Table options are an Action Time Limit and whether Live Analysis is allowed.');
    const limit = options.actionTimeLimitSeconds;
    if (limit !== undefined && limit !== null && !(actionTimeLimits as readonly unknown[]).includes(limit)) return reject('actionTimeLimitSeconds', 'Choose an Action Time Limit of 15, 30 or 60 seconds.');
    if (limit === null && request.mode === 'online') return reject('actionTimeLimitSeconds', 'An Online Table always has an Action Time Limit of 15, 30 or 60 seconds.');
    if (options.allowLiveAnalysis !== undefined && typeof options.allowLiveAnalysis !== 'boolean') return reject('allowLiveAnalysis', 'Allow Live Analysis is on or off.');
  }
  if (request.configuration !== undefined) {
    if (!object(request.configuration)) return reject('configuration', 'Supply observable settings as an object.');
    for (const key of Object.keys(request.configuration)) {
      if (!Object.hasOwn(defaultConfiguration, key)) return reject(key, 'Hidden or unknown Game Configuration fields cannot be supplied.');
    }
  }
  if (request.bots !== undefined) {
    if (!Array.isArray(request.bots)) return reject('bots', 'Supply a list of configured Bots.');
    const seatCount = request.configuration?.seatCount ?? defaultConfiguration.seatCount;
    if (request.bots.length > seatCount - 1) return reject('bots', 'Reserve one Participant for the human and at most one Bot per remaining seat.');
    for (const bot of request.bots) {
      if (!object(bot) || Object.keys(bot).some(key => !['name', 'playingStrategy'].includes(key)) || participantName(bot.name) === undefined)
        return reject('bots', 'Each Bot requires a name and a Playing Strategy. ' + participantNameRules);
      if (!supportsStrategy(bot.playingStrategy)) return reject('playingStrategy', 'Choose a supported complete Playing Strategy and its declared configuration.');
    }
  }
}
