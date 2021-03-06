const Base = require('mocha/lib/reporters/base');
//const ms = require('mocha/lib/ms');
const color = Base.color;
import { getAddressToContract, getTransactionParams } from 'embark-utils';

class EmbarkApiSpec extends Base {
  constructor(runner, options) {
    super(runner, options);

    this.embark = {events: options.reporterOptions.events};

    let suiteStack = [];

    const formatTest = function(test) {
      return {
        suite: suiteStack,
        title: test.title,
        file: test.file,
        duration: test.duration,
        state: test.state,
        speed: test.speed
      };
    };

    runner.on('start', () => this.embark.events.request('tests:results:reset'));
    runner.on('pass', test => this.embark.events.request('tests:results:report', formatTest(test)));
    runner.on('fail', test => this.embark.events.request('tests:results:report', formatTest(test)));
    runner.on('suite', suite => {
      if (suite.title !== '') suiteStack.push(suite.title);
    });
    runner.on('suite end', () => suiteStack.pop());
  }
}

class EmbarkSpec extends Base {
  constructor(runner, options) {
    super(runner, options);

    const self = this;
    self.listenForGas = true;
    self.embarkEvents = options.reporterOptions.events;
    self.gasDetails = options.reporterOptions.gasDetails;
    self.txDetails = options.reporterOptions.txDetails;
    self.gasLimit = options.reporterOptions.gasLimit;
    let indents = 0;
    let n = 0;
    self.stats.totalGasCost = 0;
    self.stats.test = {};
    self.stats.test.gasUsed = 0;
    self.contracts = [];
    self.addressToContract = {};
    self.txLogs = [];

    function onContractReceipt(receipt) {
      if (self.txDetails) {
        self.embarkEvents.request('contracts:contract', receipt.className, (contract) => {
          if (contract) {
            let index = self.contracts.findIndex(c => c.className === contract.className);
            // It's possible to deploy the same contract multiple times per test, so we need
            // to make sure we replace the existing one with the new one.
            if (index > -1) {
              self.contracts[index] = contract;
            } else {
              self.contracts.push(contract);
            }
            self.addressToContract = getAddressToContract(self.contracts, self.addressToContract);
          }
        });
      }

      if (self.gasDetails) {
        const fmt = color('bright pass', ' ') +
          color('suite', ' %s') +
          color('light', ' deployed for ') +
          color(self.getGasColor(receipt.gasUsed), '%s') +
          color('light', ' gas');

        console.log(fmt, receipt.className, receipt.gasUsed);
      }
    }

    async function onBlockHeader(blockHeader) {
      if (!self.listenForGas) {
        return;
      }
      self.stats.totalGasCost += blockHeader.gasUsed;
      self.stats.test.gasUsed += blockHeader.gasUsed;

      if (!self.txDetails) {
        return;
      }
      self.embarkEvents.request("blockchain:block:byNumber", blockHeader.number, (err, block) => {
        if (err) {
          return this.logger.error('Error getting block header', err.message || err);
        }
        // Don't know why, but sometimes we receive nothing
        if (!block || !block.transactions) {
          return;
        }
        block.transactions.forEach(transaction => {
          self.contracts.find(contract => {
            if (!contract.silent && contract.deployedAddress && transaction.to && contract.deployedAddress.toLowerCase() === transaction.to.toLowerCase()) {
              const c = self.addressToContract[contract.deployedAddress.toLowerCase()];
              if (!c) {
                return;
              }
              const {functionName, paramString} = getTransactionParams(c, transaction.input);

              self.txLogs.push(`\t\t- ${contract.className}.${functionName}(${paramString}) [${transaction.gas} gas]`);
              return true;
            }
            return false;
          });
        });
      });
    }

    self.embarkEvents.on("deploy:contract:receipt", onContractReceipt);
    self.embarkEvents.on("block:header", onBlockHeader);
    self.embarkEvents.setCommandHandler("reporter:toggleGasListener", () => {
      self.listenForGas = !self.listenForGas;
    });

    function indent() {
      return Array(indents).join('  ');
    }

    runner.on('start', function() {
      console.log();
    });

    runner.on('suite', function(suite) {
      ++indents;
      if (self.gasDetails) {
        console.log();
      }
      console.log(color('suite', '%s%s'), indent(), suite.title);
    });

    runner.on('suite end', function() {
      --indents;
      if (indents === 1) {
        console.log();
      }
    });

    runner.on('pending', function(test) {
      const fmt = indent() + color('pending', '  - %s');
      console.log(fmt, test.title);
    });


    runner.on('test', function() {
      self.stats.test.gasUsed = 0;
    });

    runner.on('pass', function(test) {
      let fmt =
        indent() +
        color('checkmark', '  ' + Base.symbols.ok) +
        color('pass', ' %s') +
        color(test.speed, ' (%dms)') +
        ' - ' +
        color(self.getGasColor(self.stats.test.gasUsed), '[%d gas]');
      console.log(fmt, test.title, test.duration, self.stats.test.gasUsed);
      self.txLogs.forEach(log => console.log(log));
      self.txLogs = [];
    });

    runner.on('fail', function(test) {
      console.log(indent() + color('fail', '  %d) %s') + ' - ' + color(self.getGasColor(self.stats.test.gasUsed), '[%d gas]'),
        ++n, test.title, self.stats.test.gasUsed);
      self.txLogs.forEach(log => console.log(log));
      self.txLogs = [];
    });

    runner.once('end', function() {
      runner.removeAllListeners();
      self.embarkEvents.removeListener("deploy:contract:receipt", onContractReceipt);
      self.embarkEvents.removeListener("block:header", onBlockHeader);
      self.epilogue();
    });
  }

  getGasColor(gasCost) {
    if (gasCost <= this.gasLimit / 10) {
      return 'fast';
    }
    if (gasCost <= 3 * (this.gasLimit / 4)) {
      return 'medium';
    }
    return 'slow';
  }

  epilogue() {
    const stats = this.stats;
    let fmt;

    console.log();

    // passes
    fmt = color('bright pass', ' ') +
      color('green', ' %d passing') +
      color('light', ' (%s)') +
      color('light', ' - [Total: %s gas]');

    console.log(fmt,
      stats.passes || 0,
      ms(stats.duration),
      stats.totalGasCost);

    // pending
    if (stats.pending) {
      fmt = color('pending', ' ') +
        color('pending', ' %d pending');

      console.log(fmt, stats.pending);
    }

    // failures
    if (stats.failures) {
      fmt = color('fail', '  %d failing');

      console.log(fmt, stats.failures);

      Base.list(this.failures);
      console.log();
    }

    console.log();
  }
}

module.exports = {EmbarkSpec, EmbarkApiSpec};
