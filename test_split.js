const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log("Running tests for Cuentas Claras split calculation...");

// Load app.js code
const appCode = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// Set up a mock global environment for app.js (it executes in browser scope)
const sandbox = {
  console: console,
  window: {
    location: { hash: '' },
    addEventListener: () => {}
  },
  document: {
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  },
  setTimeout: setTimeout,
};

// Run the script in the VM context
const context = vm.createContext(sandbox);
vm.runInContext(appCode, context);

// Helper to reset state in the VM context
function resetState(salaryA, salaryB) {
  vm.runInContext(`
    state = {
      transactions: [],
      people: {
        personA: { name: "Nicolás", salary: ${salaryA} },
        personB: { name: "Jessica", salary: ${salaryB} }
      },
      settings: { currency: "ARS" }
    };
  `, context);
}

// Helper to push transactions in the VM context
function pushTransaction(tx) {
  vm.runInContext(`state.transactions.push(${JSON.stringify(tx)});`, context);
}

// Helper to call calculateSplit in the VM context
function runCalculateSplit() {
  return vm.runInContext("calculateSplit(null)", context);
}

// Test cases
function runTests() {
  // Test 1: Equal salaries, equal expenses, no settlements
  resetState(1000, 1000);
  pushTransaction({ id: '1', type: 'expense', amount: 100, payer: 'personA', isSettlement: false });
  pushTransaction({ id: '2', type: 'expense', amount: 100, payer: 'personB', isSettlement: false });
  
  let res = runCalculateSplit();
  if (res.net >= 0.5) {
    throw new Error(`Test 1 Failed: expected net balance < 0.5, got ${res.net}`);
  }

  // Test 2: Equal salaries, A pays 100, B pays 0. B owes A 50.
  resetState(1000, 1000);
  pushTransaction({ id: '1', type: 'expense', amount: 100, payer: 'personA', isSettlement: false });
  
  res = runCalculateSplit();
  if (res.debtor !== 'personB') {
    throw new Error(`Test 2 Failed: expected debtor to be personB, got ${res.debtor}`);
  }
  if (res.creditor !== 'personA') {
    throw new Error(`Test 2 Failed: expected creditor to be personA, got ${res.creditor}`);
  }
  if (Math.abs(res.net - 50) >= 0.01) {
    throw new Error(`Test 2 Failed: expected net to be 50, got ${res.net}`);
  }

  // Test 3: Settlement. B pays A 50. Net balance should be 0.
  pushTransaction({ id: 'settle_1', type: 'settlement', amount: 50, payer: 'personB', isSettlement: true });
  
  res = runCalculateSplit();
  if (res.debtor) {
    throw new Error(`Test 3 Failed: expected no debtor (fully settled), got ${res.debtor} (net: ${res.net})`);
  }
  if (res.net >= 0.5) {
    throw new Error(`Test 3 Failed: expected net < 0.5, got ${res.net}`);
  }

  // Test 4: Opposite case. B pays 100, A pays 0. A owes B 50.
  resetState(1000, 1000);
  pushTransaction({ id: '1', type: 'expense', amount: 100, payer: 'personB', isSettlement: false });
  
  res = runCalculateSplit();
  if (res.debtor !== 'personA') {
    throw new Error(`Test 4 Failed: expected debtor to be personA, got ${res.debtor}`);
  }
  if (res.creditor !== 'personB') {
    throw new Error(`Test 4 Failed: expected creditor to be personB, got ${res.creditor}`);
  }
  if (Math.abs(res.net - 50) >= 0.01) {
    throw new Error(`Test 4 Failed: expected net to be 50, got ${res.net}`);
  }

  // Test 5: Settlement. A pays B 50. Net balance should be 0.
  pushTransaction({ id: 'settle_2', type: 'settlement', amount: 50, payer: 'personA', isSettlement: true });
  
  res = runCalculateSplit();
  if (res.debtor) {
    throw new Error(`Test 5 Failed: expected no debtor (fully settled), got ${res.debtor} (net: ${res.net})`);
  }
  if (res.net >= 0.5) {
    throw new Error(`Test 5 Failed: expected net < 0.5, got ${res.net}`);
  }

  // Test 6: Different salaries (A: 60%, B: 40%). Expenses: 100 paid by A.
  // Total expenses: 100.
  // A should pay: 60. B should pay: 40.
  // A actually paid: 100. B actually paid: 0.
  // B owes A: 40.
  resetState(600, 400);
  pushTransaction({ id: '1', type: 'expense', amount: 100, payer: 'personA', isSettlement: false });
  
  res = runCalculateSplit();
  if (res.debtor !== 'personB') {
    throw new Error(`Test 6 Failed: expected debtor to be personB, got ${res.debtor}`);
  }
  if (Math.abs(res.net - 40) >= 0.01) {
    throw new Error(`Test 6 Failed: expected net to be 40, got ${res.net}`);
  }

  // Test 7: Settlement of 40 from B to A. Net balance should be 0.
  pushTransaction({ id: 'settle_3', type: 'settlement', amount: 40, payer: 'personB', isSettlement: true });
  
  res = runCalculateSplit();
  if (res.debtor) {
    throw new Error(`Test 7 Failed: expected no debtor, got ${res.debtor}`);
  }
  if (res.net >= 0.5) {
    throw new Error(`Test 7 Failed: expected net < 0.5, got ${res.net}`);
  }

  console.log("All tests passed successfully! 🎉");
}

try {
  runTests();
} catch (err) {
  console.error("Test execution failed:", err.message);
  process.exit(1);
}
