'use strict';

// 出典の一覧は同梱データ（smoking-jp.json）の sources から作る。月次更新でデータが変わっても自動で一致する。
const box = document.getElementById('sources');

function link(url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = url;
  return a;
}

function line(label, value) {
  const p = document.createElement('p');
  const b = document.createElement('b');
  b.textContent = `${label}: `;
  p.appendChild(b);
  if (value instanceof Node) p.appendChild(value);
  else p.append(String(value));
  return p;
}

fetch('./data/smoking-jp.json')
  .then((res) => res.json())
  .then((data) => {
    const counts = {};
    for (const p of data.points) for (const s of p[5]) counts[s] = (counts[s] || 0) + 1;
    const frag = document.createDocumentFragment();
    data.sources.forEach((s, i) => {
      const sec = document.createElement('section');
      const h = document.createElement('h2');
      h.textContent = s.name;
      sec.appendChild(h);
      if (s.publisher) sec.appendChild(line('提供', s.publisher));
      sec.appendChild(line('ライセンス', s.license));
      if (s.license_url) sec.appendChild(line('ライセンス本文', link(s.license_url)));
      if (s.page) sec.appendChild(line('入手元', link(s.page)));
      if (s.asof_label) sec.appendChild(line('データ時点', s.asof_label));
      sec.appendChild(line('クレジット', s.credit));
      sec.appendChild(line('このマップでの地点数', `${counts[i] || 0}件`));
      frag.appendChild(sec);
    });
    const note = document.createElement('section');
    note.appendChild(line('データ作成日', data.built));
    note.appendChild(
      line('加工内容', 'OSM と自治体データで、50m以内にあり名称が食い違わない地点どうし（名称が一致する、または OSM 側に固有の名称がない）を、近い順に1対1で1地点に統合（名称・説明は自治体データを優先し、出典は両方を表示）。種別（紙巻き/加熱式）・屋内・時間は、元データに明記があるものだけを表示。'),
    );
    note.appendChild(line('OpenStreetMap 由来部分', 'Open Database License（ODbL）1.0 に従い、このマップの OSM 由来データも ODbL の条件で利用できます。'));
    frag.appendChild(note);
    box.replaceChildren(frag);
  })
  .catch(() => {
    box.textContent = '出典データを読み込めませんでした。';
  });
