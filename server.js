/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var path = require('path');
var url = require('url');
var express = require('express');
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs = require('fs');
var https = require('https');

var recorder_filename = 'file:///tmp/temp_video.webm';
// var recorder_filename = 'file://'+__dirname+'/static/recorder_demo.webm';


var argv = minimist(process.argv.slice(2), {
	default: {
		as_uri: 'https://localhost:8443/',
		ws_uri: 'ws://54.153.21.189:8888/kurento',
		file_uri: recorder_filename
	}
});

var options =
{
	key: fs.readFileSync('keys/server.key'),
	cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Definition of global variables.
 */
var idCounter = 0;
var candidatesQueue = {};
var kurentoClient = null;
var presenter = null;
var viewers = [];
var noPresenterMessage = 'No active presenter. Try again later...';

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function () {
	console.log('Kurento Tutorial started');
	console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
	server: server,
	path: '/one2many'
});

function nextUniqueId() {
	idCounter++;
	return idCounter.toString();
}

/*
 * Management of WebSocket messages
 */
wss.on('connection', function (ws) {

	var sessionId = nextUniqueId();
	console.log('Connection received with sessionId ' + sessionId);
	console.log("recorder_filename",recorder_filename)

	ws.on('error', function (error) {
		console.log('Connection ' + sessionId + ' error');
		stop(sessionId);
	});

	ws.on('close', function () {
		console.log('Connection ' + sessionId + ' closed');
		stop(sessionId);
	});

	ws.on('message', function (_message) {
		var message = JSON.parse(_message);
		console.log('Connection ' + sessionId + ' received message ', message);

		switch (message.id) {
			case 'presenter':
				startPresenter(sessionId, ws, message.sdpOffer, function (error, sdpAnswer) {
					if (error) {
						return ws.send(JSON.stringify({
							id: 'presenterResponse',
							response: 'rejected',
							message: error
						}));
					}
					ws.send(JSON.stringify({
						id: 'presenterResponse',
						response: 'accepted',
						sdpAnswer: sdpAnswer
					}));
				});
				break;
			case "play":
				play(sessionId, ws, message.sdpOffer, function (error, sdpAnswer) {
					if (error) {
						return ws.send(JSON.stringify({
							id: 'playResponse',
							response: 'rejected',
							message: error
						}));
					}

					ws.send(JSON.stringify({
						id: 'playResponse',
						response: 'accepted',
						sdpAnswer: sdpAnswer
					}));
				});
				break;
			case 'viewer':
				startViewer(sessionId, ws, message.sdpOffer, function (error, sdpAnswer) {
					if (error) {
						return ws.send(JSON.stringify({
							id: 'viewerResponse',
							response: 'rejected',
							message: error
						}));
					}

					ws.send(JSON.stringify({
						id: 'viewerResponse',
						response: 'accepted',
						sdpAnswer: sdpAnswer
					}));
				});
				break;

			case 'stop':
				stop(sessionId);
				break;

			case 'onIceCandidate':
				onIceCandidate(sessionId, message.candidate);
				break;

			default:
				ws.send(JSON.stringify({
					id: 'error',
					message: 'Invalid message ' + message
				}));
				break;
		}
	});
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
	if (kurentoClient !== null) {
		return callback(null, kurentoClient);
	}

	kurento(argv.ws_uri, function (error, _kurentoClient) {
		if (error) {
			console.log("Could not find media server at address " + argv.ws_uri);
			return callback("Could not find media server at address" + argv.ws_uri
				+ ". Exiting with error " + error);
		}

		kurentoClient = _kurentoClient;
		callback(null, kurentoClient);
	});
}

function startPresenter(sessionId, ws, sdpOffer, callback) {
	clearCandidatesQueue(sessionId);

	if (presenter !== null) {
		stop(sessionId);
		return callback("Another user is currently acting as presenter. Try again later ...");
	}

	presenter = {
		id: sessionId,
		pipeline: null,
		webRtcEndpoint: null
	}

	getKurentoClient(function (error, kurentoClient) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}

		if (presenter === null) {
			stop(sessionId);
			return callback(noPresenterMessage);
		}

		kurentoClient.create('MediaPipeline', function (error, pipeline) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}

			if (presenter === null) {
				stop(sessionId);
				return callback(noPresenterMessage);
			}

			presenter.pipeline = pipeline;





			createMediaElements(pipeline, ws, function (error, webRtcEndpoint, recorderEndpoint) {


				if (error) {
					stop(sessionId);
					return callback(error);
				}

				if (presenter === null) {
					stop(sessionId);
					return callback(noPresenterMessage);
				}

				presenter.webRtcEndpoint = webRtcEndpoint;



				console.log("TIOWTJHIPWTHG " + typeof webRtcEndpoint.addIceCandidate);



				if (candidatesQueue[sessionId]) {
					while (candidatesQueue[sessionId].length) {
						var candidate = candidatesQueue[sessionId].shift();
						webRtcEndpoint.addIceCandidate(candidate);
					}
				}
				connectMediaElements(webRtcEndpoint, recorderEndpoint, function (error) {
					if (error) {
						pipeline.release();
						return callback(error);
					}


					webRtcEndpoint.on('IceCandidateFound', function (event) {
						var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
						ws.send(JSON.stringify({
							id: 'iceCandidate',
							candidate: candidate
						}));
					});



					webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
						if (error) {
							stop(sessionId);
							return callback(error);
						}

						if (presenter === null) {
							stop(sessionId);
							return callback(noPresenterMessage);
						}

						callback(null, sdpAnswer);
					});

					webRtcEndpoint.gatherCandidates(function (error) {
						if (error) {
							stop(sessionId);
							return callback(error);
						}
					});





					webRtcEndpoint.on('MediaFlowInStateChange', function(event){
                        console.log('Rtp flow IN:\n');
                        console.log(event);
                    });
                    webRtcEndpoint.on('MediaFlowOutStateChange', function(event){
                        console.log('Rtp flow OUT:\n');
                        console.log(event);

                     
                    });

                    webRtcEndpoint.getConnectionState(function(err, state) {
                        if (err) {
                            console.error(err);
                        }

                        console.log(`encoder connection state: ${state}`);
                    });



					recorderEndpoint.record(function (error) {
						if (error) return callback(error);
						presenter.recorderEndpoint = recorderEndpoint;
						console.log("record");
					});


				})




			})









		});
	});
}

function startViewer(sessionId, ws, sdpOffer, callback) {
	clearCandidatesQueue(sessionId);

	if (presenter === null) {
		stop(sessionId);
		return callback(noPresenterMessage);
	}

	presenter.pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}
		viewers[sessionId] = {
			"webRtcEndpoint": webRtcEndpoint,
			"ws": ws
		}

		if (presenter === null) {
			stop(sessionId);
			return callback(noPresenterMessage);
		}

		if (candidatesQueue[sessionId]) {
			while (candidatesQueue[sessionId].length) {
				var candidate = candidatesQueue[sessionId].shift();
				webRtcEndpoint.addIceCandidate(candidate);
			}
		}

		webRtcEndpoint.on('IceCandidateFound', function (event) {
			var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
			ws.send(JSON.stringify({
				id: 'iceCandidate',
				candidate: candidate
			}));
		});

		webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}
			if (presenter === null) {
				stop(sessionId);
				return callback(noPresenterMessage);
			}

			presenter.webRtcEndpoint.connect(webRtcEndpoint, function (error) {
				if (error) {
					stop(sessionId);
					return callback(error);
				}
				if (presenter === null) {
					stop(sessionId);
					return callback(noPresenterMessage);
				}

				callback(null, sdpAnswer);
				webRtcEndpoint.gatherCandidates(function (error) {
					if (error) {
						stop(sessionId);
						return callback(error);
					}
				});
			});
		});
	});
}

function play(sessionId, ws, sdpOffer, callback) {

	getKurentoClient(function (error, kurentoClient) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}

		kurentoClient.create('MediaPipeline', function (error, pipeline) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}

			pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
				if (error) {
					stop(sessionId);
					return callback(error);
				}
				pipeline.create('PlayerEndpoint', { uri: argv.file_uri }, function (error, playerEndpoint) {
					if (error) {
						stop(sessionId);
						return callback(error);
					}

					playerEndpoint.on('EndOfStream', function (event) {
						pipeline.release();

					});

					playerEndpoint.connect(webRtcEndpoint, function (error) {
						if (error) return callback(error);

						playerEndpoint.play(function (error) {
							if (error) return callback(error);
							console.log("Playing ...");
						});
					});

				})

				webRtcEndpoint.on('IceCandidateFound', function (event) {
					var candidate = kurento.getComplexType('IceCandidate')(event.candidate);

					console.log("record iceCandiate", JSON.stringify({
						id: 'iceCandidate',
						candidate: candidate
					}));

					ws.send(JSON.stringify({
						id: 'iceCandidate',
						candidate: candidate
					}));
				});

				webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
					if (error) {
						stop(sessionId);
						return callback(error);
					}




					callback(null, sdpAnswer);
					webRtcEndpoint.gatherCandidates(function (error) {
						if (error) {
							stop(sessionId);
							return callback(error);
						}
					});

				});

				

			})



		})

	})


}

function clearCandidatesQueue(sessionId) {
	if (candidatesQueue[sessionId]) {
		delete candidatesQueue[sessionId];
	}
}

function stop(sessionId) {





	if (presenter !== null && presenter.id == sessionId) {
		for (var i in viewers) {
			var viewer = viewers[i];
			if (viewer.ws) {
				viewer.ws.send(JSON.stringify({
					id: 'stopCommunication'
				}));
			}
		}
		presenter.recorderEndpoint.stop();
		presenter.recorderEndpoint.release();
		presenter.pipeline.release();



		presenter = null;
		viewers = [];

	} else if (viewers[sessionId]) {
		viewers[sessionId].webRtcEndpoint.release();
		delete viewers[sessionId];
	}

	clearCandidatesQueue(sessionId);

	if (viewers.length < 1 && !presenter) {
		console.log('Closing kurento client');
		kurentoClient.close();
		kurentoClient = null;
	}
}

function onIceCandidate(sessionId, _candidate) {
	var candidate = kurento.getComplexType('IceCandidate')(_candidate);

	if (presenter && presenter.id === sessionId && presenter.webRtcEndpoint) {
		console.info('Sending presenter candidate');
		presenter.webRtcEndpoint.addIceCandidate(candidate);
	}
	else if (viewers[sessionId] && viewers[sessionId].webRtcEndpoint) {
		console.info('Sending viewer candidate');
		viewers[sessionId].webRtcEndpoint.addIceCandidate(candidate);
	}
	else {
		console.info('Queueing candidate');
		if (!candidatesQueue[sessionId]) {
			candidatesQueue[sessionId] = [];
		}
		candidatesQueue[sessionId].push(candidate);
	}
}


function createMediaElements(pipeline, ws, callback) {


	pipeline.create('RecorderEndpoint', { uri: argv.file_uri }, function (error, recorderEndpoint) {

		if (error) {
			console.log("ERROR CREATING PIPELINE ELEMENTS");
			return callback(error);
		}

		pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {

			if (error) {
				console.log("ERROR CREATING PIPELINE ELEMENTS");
				return callback(error);
			}

			// pipeline.create('PlayerEndpoint', {uri: argv.file_uri}, function(error, playerEndpoint){
			//
			//   if(error) {
			//     console.log("ERROR CREATING PIPELINE ELEMENTS");
			//     return callback(error);
			//   }

			return callback(null, webRtcEndpoint, recorderEndpoint);

			// });

		});


	});



	// pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
	//     if (error) {
	//         return callback(error);
	//     }
	//
	//     pipeline.create('FaceOverlayFilter', function(error, faceOverlayFilter) {
	//         if (error) {
	//             return callback(error);
	//         }
	//
	//         faceOverlayFilter.setOverlayedImage(url.format(asUrl) + 'img/mario-wings.png',
	//                 -0.35, -1.2, 1.6, 1.6, function(error) {
	//             if (error) {
	//                 return callback(error);
	//             }
	//
	//             return callback(null, webRtcEndpoint, faceOverlayFilter);
	//         });
	//     });
	// });
}


function connectMediaElements(webRtcEndpoint, recorderEndpoint, callback) {



	webRtcEndpoint.connect(webRtcEndpoint, function (error) {
		if (error) {
			return callback(error);
		}
		webRtcEndpoint.connect(recorderEndpoint, function (error) {
			if (error) {
				return callback(error);
			}


			return callback(null);
		});
	});




}




app.use(express.static(path.join(__dirname, 'static')));
