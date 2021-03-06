import { __ } from 'embark-i18n';
const async = require('async');
const Mocha = require('mocha');
const path = require('path');
import fs from 'fs';
const { dappPath, embarkPath, runCmd, timer } = require('embark-utils');
const assert = require('assert');
const Test = require('./test');
const {EmbarkSpec, EmbarkApiSpec} = require('./reporter');
const SolcTest = require('./solc_test');
import { COVERAGE_GAS_LIMIT, GAS_LIMIT } from './constants';
const Web3 = require('web3');

// TODO(andremedeiros): move to constants
const TEST_TIMEOUT = 15000; // 15 seconds in milliseconds

class TestRunner {
  constructor(embark, options) {
    this.embark = embark;
    this.logger = embark.logger;
    this.events = embark.events;
    this.fs = embark.fs;
    this.ipc = options.ipc;
    this.runners = {};
    this.gasLimit = options.coverage ? COVERAGE_GAS_LIMIT : GAS_LIMIT;

    this.events.setCommandHandler('tests:run', (options, callback) => {
      this.run(options, callback);
    });

    this.events.setCommandHandler('tests:runner:register', (name, glob, addFn, runFn) => {
      this.runners[name] = {glob, addFn, runFn};
    });
  }

  run(options, cb) {
    const self = this;

    // config to connect to a vm
    // config to use specific or random accounts for vm
    // deploy contracts
    // get contract objects, and make them available in the tests
    // V run tests
    // get tests results/data

    const testPath = options.file || "test";
    async.waterfall([
      (next) => { // list files in path
        self.getFilesFromDir(testPath, next);
      },
      (files, next) => { // group files by types
        // TODO: figure out what files belong where
        const types = { jsFiles: ".js", solidityFiles: "_test.sol" };
        const groups = Object.entries(types).reduce((acc, [type, ext]) => {
          acc[type] = files.filter(f => f.endsWith(ext));
          return acc;
        }, {});

        next(null, groups);
      },
      (groups, next) => { // run tests
        let fns = [];

        if (!options.solc && groups.jsFiles.length > 0) {
          fns.push((cb) => self.runJSTests(groups.jsFiles, options, cb));
        } else if (options.solc && groups.solidityFiles.length > 0) {
          fns.push((cb) => self.runSolidityTests(groups.solidityFiles, options, cb));
        }

        if (fns.length === 0) {
          return next('No tests to run');
        }

        async.series(fns, next);
      },
      (results, next) => { // generate coverage report
        if (!options.coverage) {
          return next(null, results);
        }

        const cmd = [
          embarkPath('node_modules/.bin/istanbul'),
          "report",
          "--root=.embark",
          "--format=html",
          "--format=lcov"
        ].join(" ");

        runCmd(cmd, {silent: false, exitOnError: false}, (err) => {
          if (err) {
            return next(err);
          }

          self.logger.info(`Coverage report created. You can find it here: ${dappPath('coverage/index.html')}`);

          if (options.noBrowser) {
            return next(null, results);
          }

          const opn = require('opn');
          const _next = () => { next(null, results); };

          opn(dappPath('coverage/index.html'), {wait: false})
            .then(() => timer(1000))
            .then(_next, _next);

        });
      },
      (results, next) => { // show report
        const totalFailures = results.reduce((acc, result) => acc + result, 0);

        (totalFailures == 0)
          ? next(null, ' > All tests passed'.green.bold)
          : next(totalFailures, ` > Total number of failures: ${totalFailures}`.red.bold);
      }
    ], (err, msg) => {
      process.stdout.write(msg + "\n");

      self.fs.remove('.embark/contracts');
      self.fs.remove('.embark/remix_tests.sol');

      return cb(err);
    });
  }


  getFilesFromDir(filePath, cb) {
    const self = this;

    self.fs.stat(filePath, (err, fileStat) => {
      const errorMessage = `File "${filePath}" doesn't exist or you don't have permission to it`.red;
      if (err) {
        return cb(errorMessage);
      }
      let isDirectory = fileStat.isDirectory();
      if (isDirectory) {
        return self.fs.readdir(filePath, (err, files) => {
          if (err) {
            return cb(err);
          }
          async.map(files, (file, _cb) => {
            self.getFilesFromDir(path.join(filePath, file), _cb);
          }, (err, arr) => {
            if (err) {
              return cb(errorMessage);
            }
            cb(null, arr.reduce((a,b) => a.concat(b), []));
          });
        });
      }
      cb(null, [filePath]);
    });
  }

  runJSTests(files, options, cb) {
    const {events} = this.embark;

    let accounts = [];
    let compiledContracts;
    let web3;

    const config = (cfg, acctCb) => {
      global.before((done) => {
        async.waterfall([
          (next) =>                              events.request("contracts:build", cfg, compiledContracts, next),
          (contractsList, contractDeps, next) => events.request("deployment:contracts:deploy", contractsList, contractDeps, next),
          (next) =>                              events.request("contracts:list", next),
          (contracts, next) => {
            for(const c of contracts) {
              const instance = new web3.eth.Contract(c.abiDefinition, c.deployedAddress);
              Object.setPrototypeOf(compiledContracts[c.className], instance);
            }
            next();
          }
        ], (_err) => {
            console.log('=====================> finished config');
            acctCb(null, accounts);
            done();
        });
      });
    };

    async.waterfall([
      (next) => { // request provider
        events.request("blockchain:client:provider", "ethereum", next);
      },
      (bcProvider, next) => { // set provider
        web3 = new Web3(bcProvider);
        next();
      },
      (next) => { // get accounts
        web3.eth.getAccounts((err, accts) => {
          if (err !== null) {
            return next(err);
          }

          accounts = accts;
          next();
        });
      },
      (next) => { // get contract files
        events.request("config:contractsFiles", next);
      },
      (cf, next) => { // compile contracts
        events.request("compiler:contracts:compile", cf, next);
      },
      (cc, next) => { // override require
        compiledContracts = cc;

        const Module = require("module");
        const originalRequire = require("module").prototype.require;
        Module.prototype.require = function(req) {
          const prefix = "Embark/contracts/";
          if (!req.startsWith(prefix)) {
            return originalRequire.apply(this, arguments);
          }

          return cc[req.replace(prefix, "")];
        };
        next();
      },
      (next) => { // setup global namespace
                next();
      },
      (next) => { // initialize Mocha
        const mocha = new Mocha();

        const describeWithAccounts = (scenario, cb) => {
          Mocha.describe(scenario, cb.bind(mocha, accounts));
        };

        mocha.suite.on('pre-require', () => {
          global.describe = describeWithAccounts;
          global.contract = describeWithAccounts;
          global.assert = assert;
          global.config = config;
        });

        mocha.suite.timeout(TEST_TIMEOUT);
        files.forEach(f => mocha.addFile(f));

        mocha.run((failures) => {
          next(null, failures);
        });
      }
    ], (err, failures) => {
      cb(err, failures);
    });
  }

  runSolidityTests(files, options, cb) {
    console.info('Running solc tests');

    let solcTest = new SolcTest({loglevel: options.loglevel, node: options.node, events: this.events, logger: this.logger,
      config: this.embark.config, ipc: this.ipc, coverage: options.coverage});
    global.embark = solcTest;
    async.waterfall([
      function initEngine(next) {
        solcTest.init(next);
      },
      function setupTests(next) {
        solcTest.setupTests(files, next);
      },
      function runTests(_reciepts ,cb) {
        let fns = files.map((file) => {
          return (cb) => {
            return solcTest.runTests(file, cb);
          };
        });
        async.series(fns, cb);
      }
    ], (err, results) => {
      if(err) return cb(err);
      let totalPass = 0;
      let totalFailures = 0;
      results.forEach((result) => {
        result.forEach((r) => {
          totalPass = totalPass + r.passingNum;
          totalFailures = totalFailures + r.failureNum;
        });
      });
      this.events.request('config:contractsFiles:reset', () => {
        cb(null, {failures: totalFailures, pass: totalPass});
      });
    });
  }
}

module.exports = TestRunner;
