var fs = require('fs');

var redis = require('redis');
var async = require('async');

var Stratum = require('stratum-pool');
var util = require('stratum-pool/lib/util.js');

module.exports = function(logger){

    var poolConfigs = JSON.parse(process.env.pools);

    var enabledPools = [];

    Object.keys(poolConfigs).forEach(function(coin) {
        var poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing &&
            poolOptions.paymentProcessing.enabled)
            enabledPools.push(coin);
    });

    async.filter(enabledPools, function(coin, callback){
        SetupForPool(logger, poolConfigs[coin], function(setupResults){
            callback(setupResults);
        });
    }, function(coins){
        coins.forEach(function(coin){

            var poolOptions = poolConfigs[coin];
            var processingConfig = poolOptions.paymentProcessing;
            var logSystem = 'Payments';
            var logComponent = coin;

            logger.debug(logSystem, logComponent, 'Payment processing setup to run every '
                + processingConfig.paymentInterval + ' second(s) with daemon ('
                + processingConfig.daemon.user + '@' + processingConfig.daemon.host + ':' + processingConfig.daemon.port
                + ') and redis (' + poolOptions.redis.host + ':' + poolOptions.redis.port + ')');

        });
    });
};


function SetupForPool(logger, poolOptions, setupFinished){


    var coin = poolOptions.coin.name;
    var processingConfig = poolOptions.paymentProcessing;

    var logSystem = 'Payments';
    var logComponent = coin;

	var opidCount = 0;
	var opids = [];

	// ZCash team recommends 10 confirmations for safety from orphaned blocks.
	var minConfShield = Math.max((processingConfig.minConf || 10), 1); // Don't allow 0 conf transactions.
	var minConfPayout = Math.max((processingConfig.minConf || 10), 1);
	if (minConfPayout  < 3) {
		logger.warning(logSystem, logComponent, logComponent + ' minConf of 3 is recommended.');
	}

	// Minimum paymentInterval of 60 seconds.
	var paymentIntervalSecs = Math.max((processingConfig.paymentInterval || 120), 30);
	if (parseInt(processingConfig.paymentInterval) < 120) {
		logger.warning(logSystem, logComponent, ' minimum paymentInterval of 120 seconds recommended.');
	}

	var maxBlocksPerPayment =  Math.max(processingConfig.maxBlocksPerPayment || 3, 1);

	// PPLNT - pay per last N time shares.
	var pplntEnabled = processingConfig.paymentMode === "pplnt" || false;
	var pplntTimeQualify = processingConfig.pplnt || 0.51; // 51%

	var getMarketStats = poolOptions.coin.getMarketStats === true;
	var requireShielding = poolOptions.coin.requireShielding === true;
	var fee = parseFloat(poolOptions.coin.txfee) || parseFloat(0.0004);

	logger.debug(logSystem, logComponent, logComponent + ' requireShielding: ' + requireShielding);
	logger.debug(logSystem, logComponent, logComponent + ' minConf: ' + minConfShield);
	logger.debug(logSystem, logComponent, logComponent + ' payments txfee reserve: ' + fee);
	logger.debug(logSystem, logComponent, logComponent + ' maxBlocksPerPayment: ' + maxBlocksPerPayment);
	logger.debug(logSystem, logComponent, logComponent + ' PPLNT: ' + pplntEnabled + ', time period: '+pplntTimeQualify);

	var daemon = new Stratum.daemon.interface([processingConfig.daemon], function(severity, message){
        logger[severity](logSystem, logComponent, message);
    });
    var redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);

    var magnitude;
    var minPayment;
    var coinPrecision;

    var paymentInterval;

    async.parallel([
        function(callback){
            daemon.cmd('validateaddress', [poolOptions.address], function(result) {
                if (result.error){
                    logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                    callback(true);
                }
                else if (!result.response || !result.response.ismine) {
                            daemon.cmd('getaddressinfo', [poolOptions.address], function(result) {
                        if (result.error){
                            logger.error(logSystem, logComponent, 'Error with payment processing daemon, getaddressinfo failed ... ' + JSON.stringify(result.error));
                            callback(true);
                        }
                        else if (!result.response || !result.response.ismine) {
                            logger.error(logSystem, logComponent,
                                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                                    + JSON.stringify(result.response));
                            callback(true);
                        }
                        else{
                            callback()
                        }
                    }, true);
                }
                else{
                    callback()
                }
            }, true);
        },
        function (callback) {
	        if (requireShielding === true) {
		        daemon.cmd('z_validateaddress', [poolOptions.zAddress], function(result) {
			        if (result.error){
				        logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
				        callback(true);
			        }
			        else if (!result.response || !result.response.ismine) {
				        logger.error(logSystem, logComponent,
					        'Daemon does not own pool address - payment processing can not be done with this daemon, '
					        + JSON.stringify(result.response));
				        callback(true);
			        }
			        else{
				        callback()
			        }
		        }, true)
	        }
        },
        function(callback){
            daemon.cmd('getbalance', [], function(result){
                if (result.error){
                    callback(true);
                    return;
                }
                try {
                    var d = result.data.split('result":')[1].split(',')[0].split('.')[1];
                    magnitude = parseInt('10' + new Array(d.length).join('0'));
                    minPayment = coinsRound(processingConfig.minimumPayment);
                    coinPrecision = magnitude.toString().length - 1;
                    callback();
                }
                catch(e){
                    logger.error(logSystem, logComponent, 'Error detecting number of satoshis in a coin, cannot do payment processing. Tried parsing: ' + result.data);
                    callback(true);
                }

            }, true, true);
        }
    ], function(err){
        if (err){
            setupFinished(false);
            return;
        }
        paymentInterval = setInterval(function(){
            try {
                processPayments();
            } catch(e){
                throw e;
            }
        }, paymentIntervalSecs * 1000);
        setTimeout(processPayments, 100);
        setupFinished(true);
    });

	// Get t_address coinbalance.
	function listUnspent (addr, notAddr, minConf, displayBool, callback) {
		if (addr !== null) {
			var args = [minConf, 99999999, [addr]];
		} else {
			addr = 'Payout wallet';
			var args = [minConf, 99999999];
		}
		daemon.cmd('listunspent', args, function (result) {
			if (!result || result.error || result[0].error) {
				logger.error(logSystem, logComponent, 'Error with RPC call listunspent ' + addr + ' ' + JSON.stringify(result[0].error));
				callback = function (){};
				callback(true);
			}
			else {
				var tBalance = 0.0;
				if (result[0].response != null && result[0].response.length > 0) {
					for (var i = 0, len = result[0].response.length; i < len; i++) {
						if (result[0].response[i].address) {
							tBalance += coinsRound(result[0].response[i].amount || 0);
						}
					}
					tBalance = coinsRound(tBalance);
				}
				if (displayBool === true) {
					logger.special(logSystem, logComponent, addr + ' balance of ' + tBalance);
				}
				callback(null, tBalance);
			}
		});
	}

	function roundTo(n, digits) {
		if (digits === undefined) {
			digits = 0;
		}
		var multiplicator = Math.pow(10, digits);
		n = parseFloat((n * multiplicator).toFixed(11));
		var test =(n / multiplicator);
		return +(test.toFixed(digits));
	}

    var satoshisToCoins = function(satoshis){
        return parseFloat((satoshis / magnitude).toFixed(coinPrecision));
    };

    var coinsToSatoshies = function(coins){
        return coins * magnitude;
    };

	function coinsRound(number) {
		return roundTo(number, coinPrecision);
	}

	function checkForDuplicateBlockHeight(rounds, height) {
		var count = 0;
		for (var i = 0; i < rounds.length; i++) {
			if (rounds[i].height == height)
				count++;
		}
		return count > 1;
	}

	// Get z_address coinbalance
	function listUnspentZ (addr, minConf, displayBool, callback) {
		daemon.cmd('z_getbalance', [addr, minConf], function (result) {
			if (!result || result.error || result[0].error) {
				logger.error(logSystem, logComponent, 'Error with RPC call z_getbalance '+addr+' '+JSON.stringify(result[0].error));
				callback = function (){};
				callback(true);
			}
			else {
				var zBalance = 0.0;
				if (result[0].response != null) {
					zBalance = coinsRound(result[0].response);
				}
				if (displayBool === true) {
					logger.special(logSystem, logComponent, addr.substring(0,14) + '...' + addr.substring(addr.length - 14) + ' balance: '+(zBalance).toFixed(8));
				}
				callback(null, zBalance);
			}
		});
	}

	// Send t_address balance to z_address
	function sendTToZ (callback, tBalance) {
		if (callback === true)
			return;
		if (tBalance === NaN) {
			logger.error(logSystem, logComponent, 'tBalance === NaN for sendTToZ');
			return;
		}
		if ((tBalance - 10) <= 0) {
			return;
		}

		// do not allow more than a single z_sendmany operation at a time
		if (opidCount > 0) {
			logger.warning(logSystem, logComponent, 'sendTToZ is waiting, too many z_sendmany operations already in progress.');
			return;
		}

		var amountSatoshi = coinsToSatoshies(tBalance);
		var amount = satoshisToCoins(amountSatoshi - 1);
		// Restrict max amount to 200000 ASF
		if (amount >= 200000) {
			amount = 199999.99;
		}

		var params = [poolOptions.address, [{'address': poolOptions.zAddress, 'amount': amount}]];
		daemon.cmd('z_sendmany', params,
			function (result) {
				//Check if payments failed because wallet doesn't have enough coins to pay for tx fees
				if (!result || result.error || result[0].error || !result[0].response) {
					logger.error(logSystem, logComponent, 'Error trying to shield balance '+amount+' '+JSON.stringify(result[0].error));
					callback = function (){};
					callback(true);
				}
				else {
					var opid = (result.response || result[0].response);
					opidCount++;
					opids.push(opid);
					logger.special(logSystem, logComponent, 'Shield balance ' + amount + ' ' + opid);
					callback = function (){};
					callback(null);
				}
			}
		);
	}

	// send z_address balance to t_address
	function sendZToT (callback, zBalance) {
		if (callback === true)
			return;
		if (zBalance === NaN) {
			logger.error(logSystem, logComponent, 'zBalance === NaN for sendZToT');
			return;
		}
		if ((zBalance - 10) <= 0)
			return;

		// do not allow more than a single z_sendmany operation at a time
		if (opidCount > 0) {
			logger.warning(logSystem, logComponent, 'sendZToT is waiting, too many z_sendmany operations already in progress.');
			return;
		}

		var amountSatoshi = coinsToSatoshies(zBalance);
		var amount = satoshisToCoins(amountSatoshi - 1);
		// Unshield no more than 20000 ASF at a time
		if (amount > 20000) {
			amount = 20000;
		}

		var params = [poolOptions.zAddress, [{'address': poolOptions.tAddress, 'amount': amount}]];
		daemon.cmd('z_sendmany', params,
			function (result) {
				//Check if payments failed because wallet doesn't have enough coins to pay for tx fees
				if (!result || result.error || result[0].error || !result[0].response) {
					logger.error(logSystem, logComponent, 'Error trying to send z_address coin balance to payout t_address.'+JSON.stringify(result[0].error));
					callback = function (){};
					callback(true);
				}
				else {
					var opid = (result.response || result[0].response);
					opidCount++;
					opids.push(opid);
					logger.special(logSystem, logComponent, 'Unshield funds for payout ' + amount + ' ' + opid);
					callback = function (){};
					callback(null);
				}
			}
		);
	}

	function cacheMarketStats() {
		var marketStatsUpdate = [];
		var coin = logComponent.replace('_testnet', '').toLowerCase();
		if (coin == 'zen')
			coin = 'zencash';

		request('https://api.coinmarketcap.com/v1/ticker/'+coin+'/', function (error, response, body) {
			if (error) {
				logger.error(logSystem, logComponent, 'Error with http request to https://api.coinmarketcap.com/ ' + JSON.stringify(error));
				return;
			}
			if (response && response.statusCode) {
				if (response.statusCode == 200) {
					if (body) {
						var data = JSON.parse(body);
						if (data.length > 0) {
							marketStatsUpdate.push(['hset', logComponent + ':stats', 'coinmarketcap', JSON.stringify(data)]);
							redisClient.multi(marketStatsUpdate).exec(function(err, results){
								if (err){
									logger.error(logSystem, logComponent, 'Error with redis during call to cacheMarketStats() ' + JSON.stringify(error));
									return;
								}
							});
						}
					}
				} else {
					logger.error(logSystem, logComponent, 'Error, unexpected http status code during call to cacheMarketStats() ' + JSON.stringify(response.statusCode));
				}
			}
		});
	}

	function cacheNetworkStats () {
		var params = null;
		daemon.cmd('getmininginfo', params,
			function (result) {
				if (!result || result.error || result[0].error || !result[0].response) {
					logger.error(logSystem, logComponent, 'Error with RPC call getmininginfo '+JSON.stringify(result[0].error));
					return;
				}

				var coin = logComponent;
				var finalRedisCommands = [];

				if (result[0].response.blocks !== null) {
					finalRedisCommands.push(['hset', coin + ':stats', 'networkBlocks', result[0].response.blocks]);
				}
				if (result[0].response.difficulty !== null) {
					finalRedisCommands.push(['hset', coin + ':stats', 'networkDiff', result[0].response.difficulty]);
				}
				if (result[0].response.networkhashps !== null) {
					finalRedisCommands.push(['hset', coin + ':stats', 'networkSols', result[0].response.networkhashps]);
				}

				daemon.cmd('getnetworkinfo', params,
					function (result) {
						if (!result || result.error || result[0].error || !result[0].response) {
							logger.error(logSystem, logComponent, 'Error with RPC call getnetworkinfo '+JSON.stringify(result[0].error));
							return;
						}

						if (result[0].response.connections !== null) {
							finalRedisCommands.push(['hset', coin + ':stats', 'networkConnections', result[0].response.connections]);
						}
						if (result[0].response.version !== null) {
							finalRedisCommands.push(['hset', coin + ':stats', 'networkVersion', result[0].response.version]);
						}
						if (result[0].response.subversion !== null) {
							finalRedisCommands.push(['hset', coin + ':stats', 'networkSubVersion', result[0].response.subversion]);
						}
						if (result[0].response.protocolversion !== null) {
							finalRedisCommands.push(['hset', coin + ':stats', 'networkProtocolVersion', result[0].response.protocolversion]);
						}

						if (finalRedisCommands.length <= 0)
							return;

						redisClient.multi(finalRedisCommands).exec(function(error, results){
							if (error){
								logger.error(logSystem, logComponent, 'Error with redis during call to cacheNetworkStats() ' + JSON.stringify(error));
								return;
							}
						});
					}
				);
			}
		);
	}

	// Run shielding process every x minutes.
	var shieldIntervalState = 0; // do not send ZtoT and TtoZ and same time, this results in operation failed!
	var shielding_interval = Math.max(parseInt(poolOptions.walletInterval || 1), 1) * 60 * 2000; // run every x minutes
	// Shielding not required for some equihash coins.
	if (requireShielding === true) {
		var shieldInterval = setInterval(function() {
			shieldIntervalState++;
			switch (shieldIntervalState) {
				case 1:
					listUnspent(poolOptions.address, null, minConfShield, false, sendTToZ);
					break;
				default:
					listUnspentZ(poolOptions.zAddress, minConfShield, false, sendZToT);
					shieldIntervalState = 0;
					break;
			}
		}, shielding_interval);
	}

	// network stats caching every 58 seconds
	var stats_interval = 58 * 1000;
	var statsInterval = setInterval(function() {
		// update network stats using coin daemon
		cacheNetworkStats();
	}, stats_interval);

	// market stats caching every 5 minutes
	if (getMarketStats === true) {
		var market_stats_interval = 300 * 1000;
		var marketStatsInterval = setInterval(function() {
			// update market stats using coinmarketcap
			cacheMarketStats();
		}, market_stats_interval);
	}

	// check operation statuses every 57 seconds
	var opid_interval =  57 * 1000;
	// shielding not required for some equihash coins
	if (requireShielding === true) {
		var checkOpids = function() {
			clearTimeout(opidTimeout);
			var checkOpIdSuccessAndGetResult = function(ops) {
				var batchRPC = [];
				// if there are no op-ids
				if (ops.length == 0) {
					// and we think there is
					if (opidCount !== 0) {
						// clear them!
						opidCount = 0;
						opids = [];
						logger.warning(logSystem, logComponent, 'Clearing operation ids due to empty result set.');
					}
				}
				// loop through op-ids checking their status
				ops.forEach(function(op, i){
					// check operation id status
					if (op.status == "success" || op.status == "failed") {
						// clear operation id result
						var opid_index = opids.indexOf(op.id);
						if (opid_index > -1) {
							// clear operation id count
							batchRPC.push(['z_getoperationresult', [[op.id]]]);
							opidCount--;
							opids.splice(opid_index, 1);
						}
						// log status to console
						if (op.status == "failed") {
							if (op.error) {
								logger.error(logSystem, logComponent, "Shielding operation failed " + op.id + " " + op.error.code +", " + op.error.message);
							} else {
								logger.error(logSystem, logComponent, "Shielding operation failed " + op.id);
							}
						} else {
							logger.special(logSystem, logComponent, 'Shielding operation success ' + op.id + '  txid: ' + op.result.txid);
						}
					} else if (op.status == "executing") {
						logger.special(logSystem, logComponent, 'Shielding operation in progress ' + op.id );
					}
				});
				// If there are no completed operations.
				if (batchRPC.length <= 0) {
					opidTimeout = setTimeout(checkOpids, opid_interval);
					return;
				}
				// Clear results for completed operations.
				daemon.batchCmd(batchRPC, function(error, results){
					if (error || !results) {
						opidTimeout = setTimeout(checkOpids, opid_interval);
						logger.error(logSystem, logComponent, 'Error with RPC call z_getoperationresult ' + JSON.stringify(error));
						return;
					}
					// Check result execution_secs vs pool_config.
					results.forEach(function(result, i) {
						if (result.result[i] && parseFloat(result.result[i].execution_secs || 0) > shielding_interval) {
							logger.warning(logSystem, logComponent, 'Warning, walletInverval shorter than opid execution time of '+result.result[i].execution_secs+' secs.');
						}
					});
					// keep checking operation ids
					opidTimeout = setTimeout(checkOpids, opid_interval);
				});
			};
			// check for completed operation ids
			daemon.cmd('z_getoperationstatus', null, function (result) {
				var err = false;
				if (result.error) {
					err = true;
					logger.error(logSystem, logComponent, 'Error with RPC call z_getoperationstatus ' + JSON.stringify(result.error));
				} else if (result.response) {
					checkOpIdSuccessAndGetResult(result.response);
				} else {
					err = true;
					logger.error(logSystem, logComponent, 'No response from z_getoperationstatus RPC call.');
				}
				if (err === true) {
					opidTimeout = setTimeout(checkOpids, opid_interval);
					if (opidCount !== 0) {
						opidCount = 0;
						opids = [];
						logger.warning(logSystem, logComponent, 'Clearing operation ids due to RPC call errors.');
					}
				}
			}, true, true);
		};
		var opidTimeout = setTimeout(checkOpids, opid_interval);
	}

    /* Deal with numbers in smallest possible units (satoshis) as much as possible. This greatly helps with accuracy
       when rounding and whatnot. When we are storing numbers for only humans to see, store in whole coin units. */

    var processPayments = function(){

        var startPaymentProcess = Date.now();

        var timeSpentRPC = 0;
        var timeSpentRedis = 0;

        var startTimeRedis;
        var startTimeRPC;

        var startRedisTimer = function(){ startTimeRedis = Date.now() };
        var endRedisTimer = function(){ timeSpentRedis += Date.now() - startTimeRedis };

        var startRPCTimer = function(){ startTimeRPC = Date.now(); };
        var endRPCTimer = function(){ timeSpentRPC += Date.now() - startTimeRedis };

        async.waterfall([

            /* Call redis to get an array of rounds - which are coinbase transactions and block heights from submitted
               blocks.

               Step 1 - build workers and rounds objects from redis
                    * removes duplicate block submissions from redis
            */
            function(callback){
                startRedisTimer();

                redisClient.multi([
                    ['hgetall', coin + ':balances'],
                    ['smembers', coin + ':blocksPending']
                ]).exec(function(error, results){
                    endRedisTimer();

                    if (error){
                        logger.error(logSystem, logComponent, 'Could not get blocks from redis ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }

					// Build workers object from :balances
                    var workers = {};
                    for (var w in results[0]){
                        workers[w] = {balance: coinsRound(results[0][w])};
                    }

					// Build rounds object from :blocksPending
                    var rounds = results[1].map(function(r){
                        var details = r.split(':');
                        return {
                            blockHash: details[0],
                            txHash: details[1],
                            height: details[2],
	                        minedby: details[3],
	                        time: details[4],
	                        duplicate: false,
                            serialized: r
                        };
                    });

	                /* sort rounds by block hieght to pay in order */
	                rounds.sort(function(a, b) {
		                return a.height - b.height;
	                });
	                // Find duplicate blocks by height
	                // This can happen when two or more solutions are submitted at the same block height.
	                var duplicateFound = false;
	                for (var i = 0; i < rounds.length; i++) {
		                if (checkForDuplicateBlockHeight(rounds, rounds[i].height) === true) {
			                rounds[i].duplicate = true;
			                duplicateFound = true;
		                }
	                }

	                // Handle duplicates if needed.
	                if (duplicateFound) {
		                var dups = rounds.filter(function(round){ return round.duplicate; });
		                logger.warning(logSystem, logComponent, 'Duplicate pending blocks found: ' + JSON.stringify(dups));

		                // Attempt to find the invalid duplicates.
		                var rpcDupCheck = dups.map(function(r){
			                return ['getblock', [r.blockHash]];
		                });
		                startRPCTimer();
		                daemon.batchCmd(rpcDupCheck, function(error, blocks){
			                endRPCTimer();
			                if (error || !blocks) {
				                logger.error(logSystem, logComponent, 'Error with duplicate block check rpc call getblock ' + JSON.stringify(error));
				                return;
			                }
			                // Look for the invalid duplicate block.
			                var validBlocks = {}; // Hashtable for unique look up.
			                var invalidBlocks = []; // Array for redis work.
			                blocks.forEach(function(block, i) {
				                if (block && block.result) {
					                // Invalid duplicate submit blocks have negative confirmations.
					                if (block.result.confirmations < 0) {
						                logger.warning(logSystem, logComponent, 'Remove invalid duplicate block ' + block.result.height + ' > ' + block.result.hash);
						                // Move from blocksPending to blocksDuplicate...
						                invalidBlocks.push(['smove', coin + ':blocksPending', coin + ':blocksDuplicate', dups[i].serialized]);
					                } else {
						                // Block must be valid, make sure it is unique.
						                if (validBlocks.hasOwnProperty(dups[i].blockHash)) {
							                // Not unique duplicate block.
							                logger.warning(logSystem, logComponent, 'Remove non-unique duplicate block ' + block.result.height + ' > ' + block.result.hash);
							                // Move from blocksPending to blocksDuplicate...
							                invalidBlocks.push(['smove', coin + ':blocksPending', coin + ':blocksDuplicate', dups[i].serialized]);
						                } else {
							                // Keep unique valid block.
							                validBlocks[dups[i].blockHash] = dups[i].serialized;
							                logger.debug(logSystem, logComponent, 'Keep valid duplicate block ' + block.result.height + ' > ' + block.result.hash);
						                }
					                }
				                }
			                });
			                // Filter out all duplicates to prevent double payments.
			                rounds = rounds.filter(function(round){ return !round.duplicate; });
			                // If we detected the invalid duplicates, move them.
			                if (invalidBlocks.length > 0) {
				                // Move invalid duplicate blocks in redis.
				                startRedisTimer();
				                redisClient.multi(invalidBlocks).exec(function(error, kicked){
					                endRedisTimer();
					                if (error) {
						                logger.error(logSystem, logComponent, 'Error could not move invalid duplicate blocks in redis ' + JSON.stringify(error));
					                }
					                // Continue payments normally.
					                callback(null, workers, rounds);
				                });
			                } else {
				                // Notify pool owner that we are unable to find the invalid duplicate blocks, manual intervention required...
				                logger.error(logSystem, logComponent, 'Unable to detect invalid duplicate blocks, duplicate block payments on hold.');
				                // Continue payments normally.
				                callback(null, workers, rounds);
			                }
		                });
	                }
	                else {
		                // No duplicates, continue payments normally.
		                callback(null, workers, rounds);
	                }
                });
            },

            /* Does a batch rpc call to daemon with all the transaction hashes to see if they are confirmed yet.
               It also adds the block reward amount to the round object - which the daemon gives also gives us.

               Step 2 - check if mined block coinbase tx are ready for payment
                     * adds block reward to rounds object
                     * adds block confirmations count to rounds object
            */
            function(workers, rounds, callback){
                // Get pending block tx details.
                var batchRPCcommand = rounds.map(function(r){
                    return ['gettransaction', [r.txHash]];
                });

	            // Get account address (not implemented at this time).
                batchRPCcommand.push(['getaccount', [poolOptions.address]]);

                startRPCTimer();
                daemon.batchCmd(batchRPCcommand, function(error, txDetails){
                    endRPCTimer();

                    if (error || !txDetails){
                        logger.error(logSystem, logComponent, 'Check finished - daemon rpc error with batch gettransactions '
                            + JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    var addressAccount = "";

	                // Check for transaction errors and generated coins.
                    txDetails.forEach(function(tx, i){
                        if (i === txDetails.length - 1){
	                        if (tx.result && tx.result.toString().length > 0) {
		                        addressAccount = tx.result.toString();
	                        }
	                        return;
                        }

                        var round = rounds[i];
	                    // Update confirmations for round.
	                    if (tx && tx.result) {
		                    round.confirmations = parseInt((tx.result.confirmations || 0));
	                    }
	                    // Look for transaction errors.
                        if (tx.error && tx.error.code === -5){
                            logger.warning(logSystem, logComponent, 'Daemon reports invalid transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }
                        else if (!tx.result.details || (tx.result.details && tx.result.details.length === 0)){
                            logger.warning(logSystem, logComponent, 'Daemon reports no details for transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }
                        else if (tx.error || !tx.result){
                            logger.error(logSystem, logComponent, 'Odd error with gettransaction ' + round.txHash + ' '
                                + JSON.stringify(tx));
                            return;
                        }

	                    // Get the coin base generation tx.
                        var generationTx = tx.result.details.filter(function(tx){
                            return tx.address === poolOptions.address;
                        })[0];


                        if (!generationTx && tx.result.details.length === 1){
                            generationTx = tx.result.details[0];
                        }

                        if (!generationTx){
                            logger.error(logSystem, logComponent, 'Missing output details to pool address for transaction '
                                + round.txHash);
                            return;
                        }

	                    // Get transaction category for round.
                        round.category = generationTx.category;
	                    // Get reward for newly generated blocks.
                        if (round.category === 'generate' || round.category === 'immature') {
                            round.reward = coinsRound(generationTx.amount || generationTx.value);
                        }
                    });

                    var canDeleteShares = function(r){
                        for (var i = 0; i < rounds.length; i++){
                            var compareR = rounds[i];
                            if ((compareR.height === r.height)
                                && (compareR.category !== 'kicked')
                                && (compareR.category !== 'orphan')
                                && (compareR.serialized !== r.serialized)){
                                return false;
                            }
                        }
                        return true;
                    };


                    // Filter out all rounds that are immature (not confirmed or orphaned yet).
	                // Only pay max blocks at a time.
	                var payingBlocks = 0;
                    rounds = rounds.filter(function(r){
                        switch (r.category) {
                            case 'orphan':
                            case 'kicked':
	                        case 'immature':
								r.canDeleteShares = canDeleteShares(r);
								return true;
                            case 'generate':
	                            payingBlocks++;
	                            // If over maxBlocksPerPayment...
	                            // Change category to immature to prevent payment
	                            // and to keep track of confirmations/immature balances.
	                            if (payingBlocks > maxBlocksPerPayment)
		                            r.category = 'immature';
	                            return true;
                            default:
                                return false;
                        }
                    });

                    // Continue to next step in waterfall.
                    callback(null, workers, rounds, addressAccount);

                });
            },


            /* Does a batch redis call to get shares contributed to each round. Then calculates the reward
               amount owned to each miner for each round.

               Step 3 - lookup shares and calculate rewards
                    * pull pplnt times from redis
                    * pull shares from redis
                    * calculate rewards
                    * pplnt share reductions if needed
            */
	        function(workers, rounds, addressAccount, callback){
		        // PPLNT times lookup.
		        var timeLookups = rounds.map(function(r){
			        return ['hgetall', coin + ':shares:times' + r.height]
		        });
		        startRedisTimer();
		        redisClient.multi(timeLookups).exec(function(error, allWorkerTimes){
			        endRedisTimer();
			        if (error){
				        callback('Check finished - redis error with multi get rounds time');
				        return;
			        }
			        // Shares lookup.
			        var shareLookups = rounds.map(function(r){
				        return ['hgetall', coin + ':shares:round' + r.height];
			        });
			        startRedisTimer();
			        redisClient.multi(shareLookups).exec(function(error, allWorkerShares){
				        endRedisTimer();
				        if (error){
					        callback('Check finished - redis error with multi get rounds share');
					        return;
				        }

				        // Error detection.
				        var err = null;
				        var performPayment = false;

				        var notAddr = null;
				        if (requireShielding === true) {
					        notAddr = poolOptions.address;
				        }

				        // Calculate what the pool owes its miners.
				        var totalOwed = 0.0;
				        for (var i = 0; i < rounds.length; i++) {
					        // Only pay generated blocks, not orphaned, kicked, immature.
					        if (rounds[i].category == 'generate') {
								totalOwed = coinsRound(totalOwed + coinsRound(rounds[i].reward) - fee);
					        }
				        }
				        // Also include balances owed.
				        for (var w in workers) {
					        var worker = workers[w];
					        totalOwed = coinsRound(totalOwed + (worker.balance || 0));
				        }
				        // Check if we have enough tAddress funds to begin payment processing.
				        listUnspent(null, notAddr, minConfPayout, false, function (error, tBalance){
					        if (error) {
						        logger.error(logSystem, logComponent, 'Error checking pool balance before processing payments.');
						        return callback(true);
					        } else if (tBalance < totalOwed) {
						        logger.error(logSystem, logComponent,  'Insufficient funds ('+tBalance + ') to process payments (' + totalOwed+'); possibly waiting for txs.');
						        performPayment = false;
					        } else if (tBalance > totalOwed) {
						        performPayment = true;
					        }
					        // Just in case...
					        if (totalOwed <= 0) {
						        performPayment = false;
					        }
					        // If we can not perform payment.
					        if (performPayment === false) {
						        // Convert category generate to immature.
						        rounds = rounds.filter(function(r){
							        switch (r.category) {
								        case 'orphan':
								        case 'kicked':
								        case 'immature':
									        return true;
								        case 'generate':
									        r.category = 'immature';
									        return true;
								        default:
									        return false;
							        }
						        });
					        }

					        // Handle rounds.
					        rounds.forEach(function(round, i){
						        var workerShares = allWorkerShares[i];
						        if (!workerShares){
							        err = true;
							        logger.error(logSystem, logComponent, 'No worker shares for round: ' + round.height + ' blockHash: ' + round.blockHash);
							        return;
						        }
						        var workerTimes = allWorkerTimes[i];

						        switch (round.category){
							        case 'kicked':
							        case 'orphan':
								        round.workerShares = workerShares;
								        break;

							        // Calculate immature balances.
							        case 'immature':
								        var immature = round.reward;
								        var totalShares = 0.0;
								        var sharesLost = 0.0;

								        // Adjust block immature .. tx fees.
								        immature = coinsRound(immature - fee);

								        // Find most time spent in this round by single worker.
								        maxTime = 0;
								        for (var workerAddress in workerTimes){
									        if (maxTime < parseFloat(workerTimes[workerAddress]))
										        maxTime = parseFloat(workerTimes[workerAddress]);
								        }
								        // Total up shares for round.
								        for (var workerAddress in workerShares){
									        var worker = workers[workerAddress] = (workers[workerAddress] || {});
									        var shares = parseFloat((workerShares[workerAddress] || 0));
									        // If PPLNT mode.
									        if (pplntEnabled === true && maxTime > 0) {
										        var address = workerAddress.split('.')[0];
										        if (workerTimes[address] != null && parseFloat(workerTimes[address]) > 0) {
													var timePeriod = roundTo(parseFloat(workerTimes[address] || 1) / maxTime , 2);
											        if (timePeriod > 0 && timePeriod < pplntTimeQualify) {
												        var lost = shares - (shares * timePeriod);
												        sharesLost += lost;
												        shares = Math.max(shares - lost, 0);
											        }
										        }
									        }
									        worker.roundShares = shares;
									        totalShares += shares;
								        }

								        //console.log('--IMMATURE DEBUG--------------');
								        //console.log('performPayment: '+performPayment);
								        //console.log('blockHeight: '+round.height);
								        //console.log('blockReward: '+Math.round(immature));
								        //console.log('blockConfirmations: '+round.confirmations);

								        // Calculate rewards for round.
								        var totalAmount = 0;
								        for (var workerAddress in workerShares){
									        var worker = workers[workerAddress] = (workers[workerAddress] || {});
									        var percent = parseFloat(worker.roundShares) / totalShares;
									        // Calculate workers immature for this round.
									        var workerImmatureTotal = coinsRound(immature * percent);
									        worker.immature = (worker.immature || 0) + workerImmatureTotal;
									        totalAmount += workerImmatureTotal;
								        }

								        //console.log('----------------------------');
								        break;

							        // Calculate reward balances.
							        case 'generate':
								        var reward = round.reward;
								        var totalShares = 0.0;
								        var sharesLost = 0.0;

								        // Adjust block reward .. tx fees.
								        reward = coinsRound(reward - fee);

								        // Find most time spent in this round by single worker.
								        maxTime = 0;
								        for (var workerAddress in workerTimes) {
									        if (maxTime < parseFloat(workerTimes[workerAddress])) {
										        maxTime = parseFloat(workerTimes[workerAddress]);
									        }
								        }
								        // Total up shares for round.
								        for (var workerAddress in workerShares) {
									        var worker = workers[workerAddress] = (workers[workerAddress] || {});
									        var shares = parseFloat((workerShares[workerAddress] || 0));
									        // If PPLNT mode.
									        if (pplntEnabled === true && maxTime > 0) {
										        var tshares = shares;
										        var address = workerAddress.split('.')[0];
										        if (workerTimes[address] != null && parseFloat(workerTimes[address]) > 0) {
											        var timePeriod = parseFloat(parseFloat(workerTimes[address] || 1) / maxTime).toFixed(coinPrecision);
											        if (timePeriod > 0 && timePeriod < pplntTimeQualify) {
												        var lost = shares - (shares * timePeriod);
												        sharesLost += lost;
												        shares = Math.max(shares - lost, 0);
												        logger.warning(logSystem, logComponent, 'PPLNT: Reduced shares for ' + workerAddress + ' round:' + round.height + ' maxTime:' + maxTime + 'sec timePeriod:' + parseFloat(timePeriod).toFixed(6) + ' shares:' + tshares + ' lost:' + lost + ' new:' + shares);
											        }
											        if (timePeriod > 1.0) {
												        err = true;
												        logger.error(logSystem, logComponent, 'Time share period is greater than 1.0 for ' + workerAddress + ' round:' + round.height + ' blockHash:' + round.blockHash);
												        return;
											        }
											        worker.timePeriod = timePeriod;
										        }
									        }
									        worker.roundShares = shares;
									        worker.totalShares = parseFloat(worker.totalShares || 0) + shares;
									        totalShares += shares;
								        }

								        //console.log('--REWARD DEBUG--------------');
								        //console.log('performPayment: '+performPayment);
								        //console.log('blockHeight: '+round.height);
								        //console.log('blockReward: ' + Math.round(reward));
								        //console.log('blockConfirmations: '+round.confirmations);

								        // Calculate rewards for round.
								        var totalAmount = 0;
								        for (var workerAddress in workerShares){
									        var worker = workers[workerAddress] = (workers[workerAddress] || {});
											var percent = parseFloat(parseFloat(worker.roundShares) / totalShares).toFixed(2);
									        if (percent > 1.0) {
										        err = true;
										        logger.error(logSystem, logComponent, 'Share percent is greater than 1.0 for ' + workerAddress + ' round:' + round.height + ' blockHash:' + round.blockHash);
										        return;
									        }
									        // Calculate workers reward for this round.
									        var workerRewardTotal = coinsRound(reward * percent);
									        worker.reward = (worker.reward || 0) + workerRewardTotal;
									        totalAmount += workerRewardTotal;
								        }

								        //console.log('----------------------------');
								        break;
						        }
					        });

					        // If there was no errors.
					        if (err === null) {
						        callback(null, workers, rounds, addressAccount);
					        } else {
						        // Some error, stop waterfall.
						        callback(true);
					        }

				        }); // end funds check
			        });// end share lookup
		        }); // end time lookup
	        },


            /* Calculate if any payments are ready to be sent and trigger them sending
               Get balance different for each address and pass it along as object of latest balances such as
               {worker1: balance1, worker2, balance2}
               when deciding the sent balance, it the difference should be -1*amount they had in db,
               if not sending the balance, the differnce should be +(the amount they earned this round)

               Step 4 - Generate RPC commands to send payments
                   When deciding the sent balance, it the difference should be -1*amount they had in db,
                   If not sending the balance, the differnce should be +(the amount they earned this round)
             */
            function(workers, rounds, addressAccount, callback) {
				var tries = 0;
                var trySend = function (withholdPercent) {
					var addressAmounts = {};
					var balanceAmounts = {};
					var shareAmounts = {};
					var minerTotals = {};
					var totalSent = 0;
					var totalShares = 0;

					// track attempts made, calls to trySend...
					tries++;

					// Total up miner's balances.
					for (var w in workers) {
						var worker = workers[w];
						totalShares += (worker.totalShares || 0)
						worker.balance = worker.balance || 0;
						worker.reward = worker.reward || 0;
						// get miner payout totals
						var toSend = coinsRound((worker.balance + worker.reward) * (1 - withholdPercent));
						var address = worker.address = (worker.address || getProperAddress(w.split('.')[0])).trim();
						if (minerTotals[address] != null && minerTotals[address] > 0) {
							minerTotals[address] += toSend;
						} else {
							minerTotals[address] = toSend;
						}
					}

					// Now process each workers balance, and pay the miner.
					for (var w in workers) {
						var worker = workers[w];
						worker.balance = worker.balance || 0;
						worker.reward = worker.reward || 0;
						var toSend = coinsRound((worker.balance + worker.reward) * (1 - withholdPercent));
						var address = worker.address = (worker.address || getProperAddress(w.split('.')[0])).trim();

						// If miners total is enough, go ahead and add this worker balance.
						if (minerTotals[address] >= minPayment) {
							totalSent += toSend;
							// Send funds.
							worker.sent = toSend;
							if (worker.sent > 0) {
								worker.balanceChange = coinsRound(Math.min(worker.balance, toSend) * -1);
								if (addressAmounts[address] != null) {
									worker.sent = coinsRound(addressAmounts[address] + worker.sent);
								}

								addressAmounts[address] = coinsRound(worker.sent);
							}
						} else {
							// Add to balance, not enough minerals.
							worker.sent = 0;
							worker.balanceChange = coinsRound(Math.max(toSend - worker.balance, 0));
							// Track balance changes.
							if (worker.balanceChange > 0) {
								if (balanceAmounts[address] != null && balanceAmounts[address] > 0) {
									balanceAmounts[address] = coinsRound(balanceAmounts[address] + worker.balanceChange);
								} else {
									balanceAmounts[address] = coinsRound(worker.balanceChange);
								}
							}
						}
						// track share work
						if (worker.totalShares > 0) {
							if (shareAmounts[address] != null && shareAmounts[address] > 0) {
								shareAmounts[address] += worker.totalShares;
							} else {
								shareAmounts[address] = worker.totalShares;
							}
						}
					}

                    if (Object.keys(addressAmounts).length === 0){
                        callback(null, workers, rounds, [], []);
                        return;
                    }

					// Do final rounding of payments per address
					// this forces amounts to be valid (5.12)
					for (var a in addressAmounts) {
					    addressAmounts[a] = coinsRound(addressAmounts[a]);
					}

					// POINT OF NO RETURN! GOOD LUCK!
					// WE ARE SENDING PAYMENT CMD TO DAEMON

					// Perform the sendmany operation .. addressAccount
					var rpccallTracking = 'sendmany "" '+JSON.stringify(addressAmounts);
					daemon.cmd('sendmany', ["", addressAmounts], function (result) {
						// Check for failed payments, there are many reasons.
						if (result.error && result.error.code === -6) {
							// Check if it is because we don't have enough funds.
							if (result.error.message && result.error.message.includes("insufficient funds")) {
								// Only try up to XX times (Max, 0.5%)
								if (tries < 5) {
									// We thought we had enough funds to send payments, but apparently not...
									// Try decreasing payments by a small percent to cover unexpected tx fees?
									var higherPercent = withholdPercent + 0.001; // 0.1%
									logger.warning(logSystem, logComponent, 'Insufficient funds (??) for payments ('+totalSent+'), decreasing rewards by ' + (higherPercent * 100).toFixed(1) + '% and retrying');
									trySend(higherPercent);
								} else {
									logger.warning(logSystem, logComponent, rpccallTracking);
									logger.error(logSystem, logComponent, "Error sending payments, decreased rewards by too much!!!");
									callback(true);
								}
							} else {
								// There was some fatal payment error?
								logger.warning(logSystem, logComponent, rpccallTracking);
								logger.error(logSystem, logComponent, 'Error sending payments ' + JSON.stringify(result.error));
								// Payment failed, prevent updates to redis.
								callback(true);
							}
							return;
						}
						else if (result.error && result.error.code === -5) {
							// Invalid address specified in addressAmounts array.
							logger.warning(logSystem, logComponent, rpccallTracking);
							logger.error(logSystem, logComponent, 'Error sending payments ' + JSON.stringify(result.error));
							// Payment failed, prevent updates to redis.
							callback(true);
							return;
						}
						else if (result.error && result.error.message != null) {
							// Invalid amount, others?
							logger.warning(logSystem, logComponent, rpccallTracking);
							logger.error(logSystem, logComponent, 'Error sending payments ' + JSON.stringify(result.error));
							// Payment failed, prevent updates to redis.
							callback(true);
							return;
						}
						else if (result.error) {
							// Unknown error.
							logger.error(logSystem, logComponent, 'Error sending payments ' + JSON.stringify(result.error));
							// Payment failed, prevent updates to redis.
							callback(true);
							return;
						}
						else {
							// Make sure sendmany gives us back a txid.
							var txid = null;
							if (result.response) {
								txid = result.response;
							}
							if (txid != null) {
								// It worked, congrats on your pools payout.
								logger.special(logSystem, logComponent, 'Sent ' + totalSent
									+ ' to ' + Object.keys(addressAmounts).length + ' miners; txid: '+txid);

								if (withholdPercent > 0) {
									logger.warning(logSystem, logComponent, 'Had to withhold ' + (withholdPercent * 100)
										+ '% of reward from miners to cover transaction fees. '
										+ 'Fund pool wallet with coins to prevent this from happening');
								}

								// Save payments data to redis
								var paymentBlocks = rounds.filter(function(r){ return r.category == 'generate'; }).map(function(r){
									return parseInt(r.height);
								});

								var paymentsUpdate = [];
								var paymentsData = {time:Date.now(), txid:txid, shares:totalShares, paid:totalSent,  miners:Object.keys(addressAmounts).length, blocks: paymentBlocks, amounts: addressAmounts, balances: balanceAmounts, work:shareAmounts};
								paymentsUpdate.push(['zadd', logComponent + ':payments', Date.now(), JSON.stringify(paymentsData)]);

								var historyUpdate = [];
								for (var address in addressAmounts) {
									var data = {
										'address': address,
										'amount': addressAmounts[address],
										'tx': txid
									};
									historyUpdate.push(data)
								}


								callback(null, workers, rounds, paymentsUpdate, historyUpdate);
							}
							else {
								clearInterval(paymentInterval);
								logger.error(logSystem, logComponent, 'Error RPC sendmany did not return txid '
									+ JSON.stringify(result) + 'Disabling payment processing to prevent possible double-payouts.');

								callback(true);
								return;
							}
						}
					}, true, true);
                };
                trySend(0);

            },

	        /*
	          Step 5 - Final redis commands
            */
            function(workers, rounds, paymentsUpdate, historyUpdate, callback) {

                var totalPaid = 0.0;

				var immatureUpdateCommands = [];
                var balanceUpdateCommands = [];
                var workerPayoutsCommands = [];
                var addressHistoryCommands = [];

				// Update worker paid/balance stats.
                for (var w in workers) {
                    var worker = workers[w];

					// Update balances.
					if ((worker.balanceChange || 0) !== 0){
						balanceUpdateCommands.push([
							'hincrbyfloat',
							coin + ':balances',
							w,
							worker.balanceChange
						]);
					}

					// Update payouts.
					if ((worker.sent || 0) > 0){
						workerPayoutsCommands.push(['hincrbyfloat', coin + ':payouts', w, coinsRound(worker.sent)]);
						totalPaid = coinsRound(totalPaid + worker.sent);
					}

					// Update immature balances.
					if ((worker.immature || 0) > 0) {
						immatureUpdateCommands.push(['hset', coin + ':immature', w, worker.immature]);
					} else {
						immatureUpdateCommands.push(['hset', coin + ':immature', w, 0]);
					}
                }

				var movePendingCommands = [];
                var roundsToDelete = [];
                var orphanMergeCommands = [];

				var confirmsUpdate = [];
				var confirmsToDelete = [];

				var moveSharesToCurrent = function(r){
					var workerShares = r.workerShares;
					if (workerShares != null) {
						logger.warning(logSystem, logComponent, 'Moving shares from orphaned block '+r.height+' to current round.');
						Object.keys(workerShares).forEach(function(worker){
							orphanMergeCommands.push(['hincrby', coin + ':shares:roundCurrent', worker, workerShares[worker]]);
						});
					}
				};

				for (let i in historyUpdate) {
                    let obj = historyUpdate[i];
                    let timestamp = Math.round(new Date().getTime());
                    let date = new Date().toUTCString();
                    let key = coin + ':history:' + obj.address + ":" + timestamp;
					addressHistoryCommands.push(['hmset', key, 'stamp', timestamp, 'tx', obj.tx, 'amount', obj.amount, 'date', date]);
                    addressHistoryCommands.push(['sadd', 'history_' + obj.address, key]);
				}

				rounds.forEach(function(r){
					switch(r.category){
						case 'kicked':
						case 'orphan':
							confirmsToDelete.push(['hdel', coin + ':blocksPendingConfirms', r.blockHash]);
							movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksKicked', r.serialized]);
							if (r.canDeleteShares){
								moveSharesToCurrent(r);
								roundsToDelete.push(coin + ':shares:round' + r.height);
								roundsToDelete.push(coin + ':shares:times' + r.height);
							}
							return;
						case 'immature':
							confirmsUpdate.push(['hset', coin + ':blocksPendingConfirms', r.blockHash, (r.confirmations || 0)]);
							return;
						case 'generate':
							confirmsToDelete.push(['hdel', coin + ':blocksPendingConfirms', r.blockHash]);
							movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksConfirmed', r.serialized]);
							roundsToDelete.push(coin + ':shares:round' + r.height);
							roundsToDelete.push(coin + ':shares:times' + r.height);
							return;
					}
				});

				var finalRedisCommands = [];

				if (movePendingCommands.length > 0)
					finalRedisCommands = finalRedisCommands.concat(movePendingCommands);

				if (orphanMergeCommands.length > 0)
					finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);

				if (immatureUpdateCommands.length > 0)
					finalRedisCommands = finalRedisCommands.concat(immatureUpdateCommands);

				if (balanceUpdateCommands.length > 0)
					finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);

				if (workerPayoutsCommands.length > 0)
					finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommands);

				if (roundsToDelete.length > 0)
					finalRedisCommands.push(['del'].concat(roundsToDelete));

				if (confirmsUpdate.length > 0)
					finalRedisCommands = finalRedisCommands.concat(confirmsUpdate);

				if (confirmsToDelete.length > 0)
					finalRedisCommands = finalRedisCommands.concat(confirmsToDelete);

				if (paymentsUpdate.length > 0)
					finalRedisCommands = finalRedisCommands.concat(paymentsUpdate);

				if (addressHistoryCommands.length > 0)
					finalRedisCommands = finalRedisCommands.concat(addressHistoryCommands);

				if (totalPaid !== 0)
					finalRedisCommands.push(['hincrbyfloat', coin + ':stats', 'totalPaid', totalPaid]);

				if (finalRedisCommands.length === 0){
					callback();
					return;
				}

                startRedisTimer();
                redisClient.multi(finalRedisCommands).exec(function(error, results){
                    endRedisTimer();
                    if (error){
                        clearInterval(paymentInterval);
                        logger.error(logSystem, logComponent,
                                'Payments sent but could not update redis. ' + JSON.stringify(error)
                                + ' Disabling payment processing to prevent possible double-payouts. The redis commands in '
                                + coin + '_finalRedisCommands.txt must be ran manually');
                        fs.writeFile(coin + '_finalRedisCommands.txt', JSON.stringify(finalRedisCommands), function(err){
                            logger.error('Could not write finalRedisCommands.txt, you are fucked.');
                        });
                    }
                    callback();
                });
            }

        ], function(){

            var paymentProcessTime = Date.now() - startPaymentProcess;
            logger.debug(logSystem, logComponent, 'Finished interval - time spent: '
                + paymentProcessTime + 'ms total, ' + timeSpentRedis + 'ms redis, '
                + timeSpentRPC + 'ms daemon RPC');

        });
    };


	var getProperAddress = function(address){
		if (address.length >= 40){
			logger.warning(logSystem, logComponent, 'Invalid address '+address+', convert to address '+(poolOptions.invalidAddress || poolOptions.address));
			return (poolOptions.invalidAddress || poolOptions.address);
		}
		if (address.length <= 30) {
			logger.warning(logSystem, logComponent, 'Invalid address '+address+', convert to address '+(poolOptions.invalidAddress || poolOptions.address));
			return (poolOptions.invalidAddress || poolOptions.address);
		}
		return address;
	};


}
