export async function fetchRows({ baseUrl, tableId, token }) {
  const rows = [];
  let url = `${baseUrl.replace(/\/$/, '')}/api/database/rows/table/${tableId}/?user_field_names=true&size=200`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
    if (!res.ok) throw new Error(`Baserow ${res.status}`);
    const data = await res.json();
    rows.push(...data.results);
    // Baserow returns `next` as http://; the downgrade makes fetch drop the Authorization header.
    url = data.next ? data.next.replace(/^http:/, 'https:') : null;
  }
  return rows;
}
