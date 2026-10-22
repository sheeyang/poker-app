const suits: Record<string, { symbol: string; name: string }> = { s: { symbol: '♠', name: 'spades' }, h: { symbol: '♥', name: 'hearts' }, d: { symbol: '♦', name: 'diamonds' }, c: { symbol: '♣', name: 'clubs' } };
export function Card({ card, small = false, dealing = false }: { card?: string; small?: boolean; dealing?: boolean }) {
  const suit = card ? suits[card.slice(-1).toLowerCase()] : undefined;
  const rank = card?.slice(0, -1).replace('T', '10');
  return <span className={`playing-card ${small ? 'card-small' : ''} ${card ? '' : 'card-back'} ${suit && ['♥', '♦'].includes(suit.symbol) ? 'red-suit' : ''} ${dealing ? 'card-dealing' : ''}`} role="img" aria-label={card ? `${rank} of ${suit?.name ?? card}` : 'Face-down card'}>
    {card && <><span className="card-index">{rank}<span>{suit?.symbol}</span></span><span className="card-suit">{suit?.symbol}</span><span className="card-index card-index-bottom" aria-hidden="true">{rank}<span>{suit?.symbol}</span></span></>}
  </span>;
}
