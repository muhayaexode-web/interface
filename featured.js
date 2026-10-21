const TOP_CLUBS = [
  'real madrid', 'barcelona', 'barça', 'manchester city', 'liverpool', 'arsenal', 'bayern', 'paris saint', 'psg',
  'manchester united', 'chelsea', 'tottenham', 'juventus', 'inter', 'ac milan', 'milan', 'atletico madrid',
  'atlético madrid', 'borussia dortmund', 'napoli', 'benfica', 'porto', 'ajax', 'leverkusen', 'roma', 'tp mazembe',
  'congo dr', 'dr congo', 'rd congo', 'rdc', 'congo (dr)',
];

const clubScore = (name = '') => {
  const index = TOP_CLUBS.findIndex((club) => name.toLowerCase().includes(club));
  return index < 0 ? 0 : 10 + (TOP_CLUBS.length - index) / TOP_CLUBS.length * 5;
};

export function selectFeaturedMatch(matches) {
  if (!matches.length) return null;
  const heat = (match) =>
    clubScore(match.home_team ?? match.home) +
    clubScore(match.away_team ?? match.away) +
    (match.open_offers > 0 ? 1 : 0);
  return matches.reduce((best, match) => (heat(match) > heat(best) ? match : best));
}
