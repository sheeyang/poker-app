const suits: Record<string, { symbol: string; name: string }> = { s: { symbol: '♠', name: 'spades' }, h: { symbol: '♥', name: 'hearts' }, d: { symbol: '♦', name: 'diamonds' }, c: { symbol: '♣', name: 'clubs' } };

/**
 * A playing card; face down without `card`. `faces`: the card has a front and a back, so the table's motion can turn
 * it over (a face-down one has only its back until the view reveals it). `attrs`: anchors for that motion.
 */
export function Card({ card, small = false, faces = false, attrs }: { card?: string; small?: boolean; faces?: boolean; attrs?: Record<`data-${string}`, string> }) {
  const suit = card ? suits[card.slice(-1).toLowerCase()] : undefined;
  const rank = card?.slice(0, -1).replace('T', '10');
  const front = card && <><span className="card-index">{rank}</span><span className="card-suit">{suit?.symbol}</span><span className="card-index card-index-bottom" aria-hidden="true">{rank}</span></>;
  const red = suit && ['♥', '♦'].includes(suit.symbol) ? 'red-suit' : '';
  const label = card ? `${rank} of ${suit?.name ?? card}` : 'Face-down card';
  if (faces) return <span className={`playing-card two-faced ${small ? 'card-small' : ''} ${red}`} role="img" aria-label={label} {...attrs}>
    {card ? <><span className="card-face">{front}</span><span className="card-back-face is-under" /></> : <span className="card-back-face" />}
  </span>;
  return <span className={`playing-card ${small ? 'card-small' : ''} ${card ? '' : 'card-back'} ${red}`} role="img" aria-label={label} {...attrs}>{front}</span>;
}
