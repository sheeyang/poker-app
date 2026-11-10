import { describe, expect, it } from 'vitest';
import { joinProblem, joinRequest } from '../src/join-form.js';

describe('the join request', () => {
  it('carries the Table Password only when the table asks for one, exactly as typed', () => {
    expect(joinRequest('r', { passwordRequired: true, tablePassword: ' Open Sesame' })).toEqual({ requestId: 'r', tablePassword: ' Open Sesame' });
    expect(joinRequest('r', { passwordRequired: false, tablePassword: 'left over' })).toEqual({ requestId: 'r' });
  });
});

describe('what a refused join tells the Guest, and where', () => {
  it('puts a wrong or missing password on the password field, naming the owner to ask', () => {
    expect(joinProblem({ code: 'wrong-table-password', message: 'server words' }, 'Sam')).toEqual({ field: 'tablePassword', message: 'That password isn’t right. Check it with Sam and try again.' });
    expect(joinProblem({ code: 'table-password-required', message: 'server words' }, 'Sam')).toEqual({ field: 'tablePassword', message: 'Enter the Table Password. Sam can tell you what it is.' });
  });
  it('puts a taken or invalid name on the name field', () => {
    expect(joinProblem({ code: 'name-taken', message: 'Someone at this table already uses that name.' }, 'Sam')).toEqual({ field: 'displayName', message: 'Someone at this table already uses that name.' });
    expect(joinProblem({ code: 'invalid-display-name', message: 'Use 1 to 20 letters.' }, 'Sam')).toEqual({ field: 'displayName', message: 'Use 1 to 20 letters.' });
  });
  it('keeps any other refusal for the whole form, and explains a failure that is not a refusal', () => {
    expect(joinProblem({ code: 'table-full', message: 'This table is full.' }, 'Sam')).toEqual({ field: 'form', message: 'This table is full.' });
    expect(joinProblem(undefined, 'Sam')).toEqual({ field: 'form', message: 'Couldn’t join this table. Check your connection and try again.' });
  });
});
