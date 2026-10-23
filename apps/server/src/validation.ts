import { isSupportedStrategy } from '@poker/strategies';
import { defaultConfiguration, type ApplicationRejection, type CreateTableSessionRequest } from '@poker/contracts';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validateTrainerConfiguration(value: unknown, supportsStrategy: (descriptor: unknown) => boolean = isSupportedStrategy): ApplicationRejection | undefined {
  if (!object(value) || Object.keys(value).some(key => !['referenceStrategy', 'liveAnalysis'].includes(key)) || typeof value.liveAnalysis !== 'boolean')
    return { ok: false, rejection: { code: 'invalid-trainer-configuration', message: 'Supply a complete Reference Strategy and a boolean Live Analysis setting.' } };
  if (!supportsStrategy(value.referenceStrategy))
    return { ok: false, rejection: { code: 'unsupported-strategy', message: 'Choose a supported complete Reference Strategy.' } };
}
export function validateCreationRequest(request: CreateTableSessionRequest, supportsStrategy: (descriptor: unknown) => boolean = isSupportedStrategy): ApplicationRejection | undefined {
  const reject = (field: string, message: string): ApplicationRejection => ({ ok: false, rejection: { code: 'invalid-creation-settings', field, message } });
  for (const key of Object.keys(request)) {
    if (!['requestId', 'configuration', 'bots'].includes(key)) return reject(key, 'Creation accepts only observable configuration and Bot controller intentions.');
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
      if (!object(bot) || Object.keys(bot).some(key => !['name', 'playingStrategy'].includes(key)) || typeof bot.name !== 'string' || bot.name.trim().length === 0 || bot.name.length > 64)
        return reject('bots', 'Each Bot requires a name from 1 to 64 characters and a Playing Strategy.');
      if (!supportsStrategy(bot.playingStrategy)) return reject('playingStrategy', 'Choose a supported complete Playing Strategy and its declared configuration.');
    }
  }
}
