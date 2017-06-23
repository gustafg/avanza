"use strict";

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.invoke_auth_chain = invoke_auth_chain;
function invoke_auth_chain(session_info) {
    if (session_info === undefined) throw Error("session_info cannot be undefined");
    if (!session_info.personnr || !session_info.username) throw Error("session_info wrong, expected format: {personnr: ..., username: ....}");

    session_info.cookies = {};

    return Promise.resolve(session_info).then(bankid_authenticate).then(bankid_collect).then(auth_eid_login).then(kontooversikt);
}

var debug = false;

var https = require('https');
var querystring = require('querystring');

function httplog(level, header, data) {
    if (debug) {
        console.log("====================");
        console.log(header);
        console.log(data);
        console.log("====================");
    }
}

function update_cookies(cookie_array, cookies) {
    if (cookie_array === undefined) return;
    cookie_array.map(function (item) {
        // Given AZASID="";Version=1;Path=/;Secure;HttpOnly;Secure
        // keep only AZASID=""
        return item.split(";")[0];
    }).forEach(function (item) {
        // Put the cookie onto the 
        var tmp = item.split("=");
        var key = tmp[0];
        var value = tmp.slice(1).join("=");
        cookies[key] = value;
    });
}

function set_request_cookies(request, cookies) {
    if (cookies === undefined) throw new Error("BUG! The cookies parameter was undefined. This shouldn't be unless you made a typo!");
    if (Object.keys(cookies).length == 0) return;
    request.setHeader('Cookie', Object.keys(cookies).map(function (key) {
        return key + "=" + cookies[key];
    }).join("; "));
}

// https://www.avanza.se/ab/bankid/authenticate
function bankid_authenticate(session_info) {
    return new Promise(function (resolve, reject) {
        var post_data = querystring.stringify({ personnummer: session_info.personnr });
        var options = {
            method: 'POST',
            host: 'www.avanza.se',
            path: '/ab/bankid/authenticate',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(post_data)
            }
        };
        var req = https.request(options, function (res) {
            var response_data = "";
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                response_data += chunk;
            });
            res.on('end', function () {
                httplog(0, res.headers, response_data);
                if (res.statusCode != 200) reject("" + res.statusCode + ": " + response_data);
                var response_obj = JSON.parse(response_data);
                if (response_obj.hasOwnProperty("error")) // {"error":"already_in_progress"}
                    reject(response_data);
                update_cookies(res.headers['set-cookie'], session_info.cookies);
                session_info.bankid_authenticate = response_obj;
                resolve(session_info);
            });
        });
        set_request_cookies(req, session_info.cookies);
        req.write(post_data);
        req.end();
        httplog(0, options, post_data);
    });
}

// https://www.avanza.se/ab/bankid/collect
function bankid_collect(session_info) {
    return new Promise(function (resolve, reject) {
        // FIXME: Endless loop, we should enhance this.
        var timer = setInterval(function () {
            var post_data = querystring.stringify({ transactionId: session_info.bankid_authenticate.transactionId });
            var options = {
                method: 'POST',
                host: 'www.avanza.se',
                path: '/ab/bankid/collect',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(post_data)
                }
            };
            var req = https.request(options, function (res) {
                var response_data = "";
                res.setEncoding('utf8');
                res.on('data', function (chunk) {
                    response_data += chunk;
                });
                res.on('end', function () {
                    httplog(0, res.headers, response_data);
                    if (res.statusCode != 200) {
                        clearInterval(timer);
                        reject(res);
                    }
                    var response_obj = JSON.parse(response_data);
                    if (response_obj.hasOwnProperty("error")) {
                        // { error: 'expired_transaction' }
                        clearInterval(timer);
                        reject(response_data);
                    }
                    switch (response_obj.state) {
                        case "outstanding_transaction":
                        case "user_sign":
                            // Poll again
                            break;
                        case "complete":
                            clearInterval(timer);
                            update_cookies(res.headers['set-cookie'], session_info.cookies);
                            for (var i = 0; i < response_obj.availableLogins.length; i++) {
                                var o = response_obj.availableLogins[i];
                                if (o.username == username) {
                                    session_info.custinfo = o;
                                    break;
                                }
                            }
                            if (i > response_obj.availableLogins.length) reject("Invalid username: " + session_info.username + ", Avanza responds with: " + response_data);
                            session_info.bankid_collect = response_obj;
                            resolve(session_info);
                            break;
                        default:
                            clearInterval(timer);
                            reject("Unexpected response: " + response_data);
                    }
                });
            });
            set_request_cookies(req, session_info.cookies);
            req.write(post_data);
            req.end();
            httplog(0, options, post_data);
        }, 2000);
    });
}

// https://www.avanza.se/ab/auth_eid/login
function auth_eid_login(session_info) {
    return new Promise(function (resolve, reject) {
        // FIXME -- We should assert that the username exist.
        var post_data = JSON.stringify({ username: session_info.username });
        var options = {
            method: 'POST',
            host: 'www.avanza.se',
            path: '/ab/auth_eid/login',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(post_data)
            }
        };
        var req = https.request(options, function (res) {
            var response_data = "";
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                response_data += chunk;
            });
            res.on('end', function () {
                httplog(0, res.headers, response_data);
                var response_obj = JSON.parse(response_data);
                if (response_obj.hasOwnProperty("error")) // Never observed
                    reject(response_data);
                update_cookies(res.headers['set-cookie'], session_info.cookies);
                session_info.auth_eid_login = response_obj;
                session_info.aza_usertoken = res.headers['aza-usertoken'];
                resolve(session_info);
            });
        });
        set_request_cookies(req, session_info.cookies);
        req.write(post_data);
        req.end();
        httplog(0, options, post_data);
    });
}

var cheerio = require("cheerio");
function kontooversikt(session_info) {
    return new Promise(function (resolve, reject) {
        var options = {
            method: 'GET',
            host: 'www.avanza.se',
            path: '/mina-sidor/kontooversikt.html'
        };
        var req = https.request(options, function (res) {
            var response_data = "";
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                response_data += chunk;
            });
            res.on('end', function () {
                session_info.kontooversikt = cheerio.load(response_data)("#loginWrapper").data();
                httplog(0, res.headers, session_info.kontooversikt);
                update_cookies(res.headers['set-cookie'], session_info.cookies);
                resolve(session_info);
            });
        });
        set_request_cookies(req, session_info.cookies);
        req.end();
        httplog(0, options, {});
    });
}