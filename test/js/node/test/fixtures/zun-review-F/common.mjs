// Shared by the client-*.mjs scripts: run a fetch and reduce the outcome to JSON.
export const CA = process.env.CA;
export async function attempt(label, url, init) {
  try {
    const res = await fetch(url, init);
    return { label, ok: true, status: res.status, body: await res.text() };
  } catch (err) {
    return { label, ok: false, code: err?.code ?? null, message: String(err?.message ?? err).slice(0, 200) };
  }
}
export const done = result => {
  console.log(JSON.stringify(result));
  process.exit(0);
};
