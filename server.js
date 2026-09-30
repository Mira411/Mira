const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const crypto = require('crypto');

dotenv.config();

const app = express();
const PORT = 3000;
const ROOT = __dirname;
const CURRENCY = 'NGN';
const FLUTTERWAVE_API_URL = 'https://api.flutterwave.com/v3/payments';
const PRODUCT_CATALOG = {
  1: { name: 'Second Skin Tint', price: 32 },
  2: { name: 'Cloud Cream Blush', price: 24 },
  3: { name: 'Soft Focus Lip Oil', price: 22 },
  4: { name: 'After Hours Palette', price: 38 },
};
const pendingPayments = new Map();

app.use(express.json({ limit: '10kb' }));
app.use('/assets', express.static(path.join(ROOT, 'assets'), { dotfiles: 'deny' }));

function sendPage(fileName) {
  return (_req, res) => res.sendFile(path.join(ROOT, fileName));
}

app.get('/', sendPage('index.html'));
app.get('/index.html', sendPage('index.html'));
app.get('/style.css', sendPage('style.css'));
app.get('/script.js', sendPage('script.js'));
app.get('/payment-complete.html', sendPage('payment-complete.html'));

function calculateOrder(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Your bag is empty.');

  const normalizedItems = items.map(({ id, quantity }) => {
    const product = PRODUCT_CATALOG[Number(id)];
    const parsedQuantity = Number(quantity);
    if (!product || !Number.isInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > 20) {
      throw new Error('Your bag contains an invalid item.');
    }
    return { id: Number(id), name: product.name, price: product.price, quantity: parsedQuantity };
  });

  return {
    items: normalizedItems,
    amount: Number(normalizedItems.reduce((total, item) => total + item.price * item.quantity, 0).toFixed(2)),
  };
}

function hasTestSecretKey() {
  return /^FLWSECK_TEST-/.test(process.env.FLW_SECRET_KEY || '');
}

app.post('/api/create-payment', async (req, res) => {
  const { amount, email, name, items } = req.body || {};
  const customerEmail = String(email || '').trim();
  const customerName = String(name || '').trim();

  if (!hasTestSecretKey()) {
    return res.status(500).json({ error: 'Flutterwave TEST secret key is not configured on the server.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(customerEmail) || !customerName) {
    return res.status(400).json({ error: 'Enter a valid name and email address.' });
  }

  let order;
  try {
    order = calculateOrder(items);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  // Accept the displayed amount for consistency, but only the server-calculated total is charged.
  if (Number(amount) !== order.amount) {
    return res.status(400).json({ error: 'Your bag total changed. Please review your order and try again.' });
  }

  const txRef = `mira-test-${Date.now()}-${crypto.randomUUID()}`;
  pendingPayments.set(txRef, { amount: order.amount, currency: CURRENCY, createdAt: Date.now() });

  try {
    const flutterwaveResponse = await fetch(FLUTTERWAVE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount: order.amount,
        currency: CURRENCY,
        redirect_url: `http://localhost:${PORT}/payment-complete.html`,
        customer: { email: customerEmail, name: customerName },
        meta: { order_reference: txRef, item_count: order.items.reduce((count, item) => count + item.quantity, 0) },
        customizations: { title: 'Mira Beauty', description: 'Mira Beauty test order' },
      }),
    });
    const data = await flutterwaveResponse.json();

    if (!flutterwaveResponse.ok || !data?.data?.link) {
      pendingPayments.delete(txRef);
      return res.status(flutterwaveResponse.status || 502).json({ error: data?.message || 'Flutterwave could not create a checkout link.' });
    }
    return res.json({ link: data.data.link });
  } catch {
    pendingPayments.delete(txRef);
    return res.status(502).json({ error: 'Unable to reach Flutterwave. Please try again.' });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  const { transactionId, txRef } = req.body || {};
  const expectedPayment = pendingPayments.get(txRef);
  if (!transactionId || !expectedPayment) return res.status(400).json({ verified: false, error: 'Unknown or expired payment reference.' });

  try {
    const flutterwaveResponse = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`, {
      headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` },
    });
    const data = await flutterwaveResponse.json();
    const payment = data?.data;
    const verified = flutterwaveResponse.ok
      && payment?.status === 'successful'
      && payment.tx_ref === txRef
      && payment.currency === expectedPayment.currency
      && Number(payment.amount) === expectedPayment.amount;

    if (!verified) return res.status(400).json({ verified: false, error: 'Payment verification failed.' });
    pendingPayments.delete(txRef);
    return res.json({ verified: true });
  } catch {
    return res.status(502).json({ verified: false, error: 'Unable to verify the payment. Please try again.' });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError) return res.status(400).json({ error: 'Invalid request data.' });
  return res.status(500).json({ error: 'Unexpected server error.' });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, () => console.log(`Mira is running at http://localhost:${PORT}`));

