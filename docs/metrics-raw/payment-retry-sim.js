// Standalone reproduction of the exact retry-loop shape from
// OrdersService.processPayment / the in-file mock paymentService.
// Math.random is forced to always fail, to measure the DETERMINISTIC
// worst-case latency bound (natural 10% failure practically never chains
// this long — P(1000 consecutive failures) ~ 1e-1000 — so this simulates
// the theoretical worst case the old maxRetries=1000 exposed callers to).
//
// Usage: node payment-retry-sim.js <maxRetries>
'use strict';

const maxRetries = parseInt(process.argv[2] || '3', 10);

Math.random = () => 0; // forces `Math.random() < 0.1` to always be true -> always throws

async function mockPaymentCall() {
  await new Promise((resolve) => setTimeout(resolve, 100)); // mock latency, verbatim from source
  if (Math.random() < 0.1) {
    throw new Error('Payment service unavailable');
  }
  return { success: true, transactionId: `TXN-${Date.now()}` };
}

async function processPayment() {
  const start = Date.now();
  let lastError;
  let attempts = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    attempts = attempt + 1;
    try {
      const result = await mockPaymentCall();
      if (result.success) {
        return { outcome: 'success', attempts, elapsedMs: Date.now() - start };
      }
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100)); // verbatim backoff from source
    }
  }
  return {
    outcome: 'exhausted',
    attempts,
    elapsedMs: Date.now() - start,
    lastError: lastError && lastError.message,
  };
}

processPayment().then((r) => {
  console.log(JSON.stringify({ maxRetries, ...r }, null, 2));
});
