// 상품 데이터 — 여기에 상품을 추가하거나 수정하세요.
const products = [
  { id: 1, name: '데일리 머그컵', desc: '도자기 · 350ml', price: 18000, original: 22000, cat: 'kitchen', img: 'images/mug.svg' },
  { id: 2, name: '캔버스 토트백', desc: '두꺼운 면 캔버스', price: 29000, cat: 'living', img: 'images/tote.svg' },
  { id: 3, name: '무드 스탠드 조명', desc: '3단계 밝기 조절', price: 59000, original: 69000, cat: 'living', img: 'images/lamp.svg' },
  { id: 4, name: '미니 화분 세트', desc: '공기정화 식물 포함', price: 24000, cat: 'living', img: 'images/plant.svg' },
  { id: 5, name: '하드커버 노트', desc: 'A5 · 무지 160쪽', price: 12000, cat: 'stationery', img: 'images/notebook.svg' },
  { id: 6, name: '소이 캔들', desc: '라벤더 향 · 200g', price: 21000, original: 25000, cat: 'living', img: 'images/candle.svg' }
];

const won = (n) => '₩' + n.toLocaleString('ko-KR');
const cart = new Map(); // id -> 수량
let category = 'all';
let query = '';

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');

function renderProducts() {
  const list = products.filter((p) =>
    (category === 'all' || p.cat === category) &&
    (!query || (p.name + p.desc).toLowerCase().includes(query.toLowerCase())));
  grid.innerHTML = list.map((p) => `
    <article class="product">
      <div class="product-img">
        <img src="${p.img}" alt="${p.name}">
        ${p.original ? `<span class="sale">${Math.round((1 - p.price / p.original) * 100)}% 할인</span>` : ''}
      </div>
      <h3>${p.name}</h3>
      <p class="desc">${p.desc}</p>
      <div class="price-row">
        <span class="price">${won(p.price)}${p.original ? `<s>${won(p.original)}</s>` : ''}</span>
        <button class="add" data-id="${p.id}">담기</button>
      </div>
    </article>`).join('');
  empty.hidden = list.length > 0;
}

function renderCart() {
  const list = document.getElementById('cart-list');
  let count = 0;
  let total = 0;
  const rows = [];
  for (const [id, qty] of cart) {
    const p = products.find((x) => x.id === id);
    count += qty;
    total += p.price * qty;
    rows.push(`<li>
      <img src="${p.img}" alt="">
      <div><b>${p.name}</b><div class="qty"><button data-dec="${id}">−</button>${qty}<button data-inc="${id}">+</button></div></div>
      <span>${won(p.price * qty)}</span>
    </li>`);
  }
  list.innerHTML = rows.join('') || '<li class="empty-cart">장바구니가 비어 있습니다.</li>';
  const badge = document.getElementById('cart-count');
  badge.textContent = count;
  badge.classList.remove('bump');
  void badge.offsetWidth;
  badge.classList.add('bump');
  document.getElementById('cart-total').textContent = won(total);
}

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('.add');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  cart.set(id, (cart.get(id) || 0) + 1);
  btn.textContent = '담김 ✓';
  setTimeout(() => { btn.textContent = '담기'; }, 900);
  renderCart();
});

document.getElementById('cart-list').addEventListener('click', (e) => {
  const inc = e.target.dataset.inc;
  const dec = e.target.dataset.dec;
  if (inc) cart.set(Number(inc), cart.get(Number(inc)) + 1);
  if (dec) {
    const q = cart.get(Number(dec)) - 1;
    if (q <= 0) cart.delete(Number(dec)); else cart.set(Number(dec), q);
  }
  if (inc || dec) renderCart();
});

document.getElementById('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter');
  if (!btn) return;
  category = btn.dataset.cat;
  document.querySelectorAll('.filter').forEach((b) => b.classList.toggle('active', b === btn));
  renderProducts();
});

document.getElementById('search').addEventListener('input', (e) => {
  query = e.target.value.trim();
  renderProducts();
});

const drawer = document.getElementById('drawer');
document.getElementById('cart-btn').onclick = () => drawer.classList.add('open');
document.getElementById('drawer-close').onclick = () => drawer.classList.remove('open');
drawer.addEventListener('click', (e) => { if (e.target === drawer) drawer.classList.remove('open'); });
document.getElementById('checkout').onclick = () => {
  if (!cart.size) return alert('장바구니가 비어 있습니다.');
  alert('주문이 접수되었습니다. 감사합니다!');
  cart.clear();
  renderCart();
  drawer.classList.remove('open');
};

renderProducts();
renderCart();
