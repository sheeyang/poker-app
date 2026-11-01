/** Creation requires a display name; most tests only need some valid one. */
export async function nameGuest(origin: string, cookie: string, displayName = 'You') {
  const response = await fetch(origin + '/api/display-name', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ displayName }) });
  if (!response.ok) throw new Error('Could not name the Guest.');
}
