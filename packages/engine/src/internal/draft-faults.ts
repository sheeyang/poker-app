/** Private fault injection for tests; never exported by the Engine package or supplied draft data. */
export const draftFaults: { afterEvaluation?: () => void } = {};
