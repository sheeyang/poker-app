import { defaultConfiguration, type ApplicationRejection, type CreateTableSessionRequest } from '@poker/contracts';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validateCreationRequest(request: CreateTableSessionRequest): ApplicationRejection | undefined {
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
      const strategy = bot.playingStrategy;
      if (!object(strategy) || Object.keys(strategy).some(key => !['policy', 'selector'].includes(key)))
        return reject('playingStrategy', 'Supply a Policy and Action Selector descriptor.');
      for (const [key, id] of [['policy', 'uniform-choice'], ['selector', 'seeded-sampling']] as const) {
        const descriptor = strategy[key];
        if (!object(descriptor) || descriptor.id !== id || descriptor.version !== 'v1' ||
            !object(descriptor.configuration) || Object.keys(descriptor.configuration).length !== 0 ||
            Object.keys(descriptor).some(field => !['id', 'version', 'configuration'].includes(field)))
          return reject('playingStrategy', 'Choose the supported baseline Playing Strategy version v1 with empty configuration.');
      }
    }
  }
}
