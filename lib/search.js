// Tiny BM25 index: free, instant, and good enough for site-sized corpora.
const STOP = new Set(('a an the and or of to in on for with is are was were be been by at as it its this that these those from your you we our us i me my ' +
  'can will do does did how what when where which who whom why not no yes if then than so but about into over more most all any also just get').split(' '));

export function tokenize(s) {
  return (String(s).toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]+/gu) || [])
    .filter(t => t.length > 1 && !STOP.has(t))
    .map(t => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

export class SearchIndex {
  constructor(docs) {
    this.docs = docs;
    this.tf = docs.map(d => {
      const m = new Map();
      for (const t of tokenize(`${d.title} ${d.title} ${d.text}`)) m.set(t, (m.get(t) || 0) + 1);
      return m;
    });
    this.len = this.tf.map(m => [...m.values()].reduce((a, b) => a + b, 0));
    this.avg = this.len.reduce((a, b) => a + b, 0) / (this.len.length || 1);
    this.df = new Map();
    for (const m of this.tf) for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
  }

  search(query, k = 5) {
    const q = [...new Set(tokenize(query))];
    if (!q.length) return [];
    const N = this.docs.length, k1 = 1.4, b = 0.75;
    const scored = [];
    this.tf.forEach((m, i) => {
      let s = 0;
      for (const t of q) {
        const f = m.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * this.len[i] / this.avg));
      }
      if (s > 0) scored.push([s, i]);
    });
    return scored.sort((a, b) => b[0] - a[0]).slice(0, k).map(([score, i]) => ({ ...this.docs[i], score: Number(score.toFixed(2)) }));
  }
}
