"use strict";

let image_downloader = require("image-downloader");
let exif = require("exif");
let parseString = require("xml2js").parseString;
let Db = require("mongodb").Db;
let Server = require("mongodb").Server;
let Code = require("mongodb").Code;
let http = require("http");
let fs = require("fs");
let imagePath = "/home/srowe/waldo/images";
let url = "http://s3.amazonaws.com/waldo-recruiting";

http.get(url, (response) => {
    const statusCode = response.statusCode;
    const contentType = response.headers["content-type"];
    let db = new Db("test", new Server("localhost", 27017));
    let error;
    let xml = '';
    
    if (statusCode !== 200) {
        error = new Error("Request Failed.\n" + "Status Code: ${statusCode}");
    } else if (!/^application\/xml/.test(contentType)) {
        error = new Error("Invalid content-type.\n" + "Expected application/xml but received ${contentType}");
    }

    if (error) {
        console.log(error.message);
        response.resume();
        return;
    }

    response.setEncoding("utf8");

    response.on("data", (chunk) => xml += chunk);
    
    response.on("end", () => {

        /**
         * This method will consume the end point url and create a list of files to be downloaded.
         * @returns {Promise}
         */
        let parseStringAsPromise = function() {
            console.log("Parsing\n");
            let images = [];
            
            return new Promise(function (fulfill, reject) {
                parseString(xml, function (err, result) {
                    if (!result.hasOwnProperty("ListBucketResult")) {
                        reject("Expected to find ListBucketResult but it was not there");
                    }

                    else if (!result.ListBucketResult.hasOwnProperty("Contents")) {
                        reject("Expected to find Contents but it was not there");
                    }

                    else {
                        for (let i in result.ListBucketResult.Contents) {
                            images.push(result.ListBucketResult.Contents[i].Key);
                        }

                        fulfill(images);
                    }
                });
            });
        };

        /**
         * This method will download all the images found referenced in the xml returned from the s3 url
         * @param images
         * @returns {Promise}
         */
        let downloadImagesAsPromise = function(images) {
            console.log("Downloading " + images.length + " images\n");
            let files = [];

            return new Promise(function(fulfill, reject) {
                let downloaded = false;
                let downloading = false;
                let index = 0;
                let error = false;

                function download(file) {
                    console.log("Getting image " + file);
                    downloading = true;

                    if (fs.existsSync(imagePath + "/" + file)) {
                        console.log("File already exists. Not going to download\n");
                        files.push(file);
                        downloaded = true;
                        downloading = false;
                        index++;
                    }

                    else {
                        image_downloader({
                            url: url + "/" + file,
                            dest: imagePath,

                            done: function (err, filename, image) {
                                if (err) {
                                    error = err;
                                }
                                else {
                                    files.push(filename);
                                }

                                downloaded = true;
                                downloading = false;
                                index++;
                            }
                        });
                    }
                }


                /**
                 * Convenience method to do the downloading to separate out the logic from the caller in the interval
                 * method below
                 * @param filename
                 */
                let interval = setInterval(function() {
                    if (!downloading && !downloaded) {
                        download(images[index]);
                    }

                    if (downloaded) {
                        downloaded = false;

                        if (error) {
                            console.log(error);
                            error = false;
                        }

                        if (index === images.length) {
                            console.log("Done downloading files\n\n");
                            clearInterval(interval);
                            fulfill(files)
                        }
                    }
                }, 500);
            });
        };

        /**
         * This method will parse through a given array of images, extract the exif data for each image, and
         * return an array of objects representing that data. The filename is inserted into the exif data.
         * @param files
         * @returns {Promise}
         */
        let parseExifsAsPromise = function(files) {
            let objects = [];
            console.log("Parsing exif for " + files.length + " files");

            return new Promise(function(fulfill, reject) {
                let parsed = false;
                let parsing = false;
                let index = 0;
                let error = false;

                /**
                 * Convenience method to do the extracting to separate out the logic from the caller in the interval
                 * method below
                 * @param filename
                 */
                function getExif(filename) {
                    console.log("Getting exif for image " + filename + "\n");
                    parsing = true;

                    exif(filename, function (err, obj) {
                        console.log("Got exif data for " + filename + "\n");
                        if (err) {
                            error = err;
                        }
                        else {
                            obj.exif.filename = filename.substring(filename.lastIndexOf("/") + 1);
                            console.log("Set exif.filename to " + obj.exif.filename + "\n");
                            objects.push(obj.exif);
                        }

                        parsed = true;
                        parsing = false;
                        index++;
                    });
                }

                /**
                 * I chose to use an interval here since a for loop will not wait on a promise. There may be
                 * better ways to do this (such as building a chain of promises).
                 * @type {any}
                 */
                let interval = setInterval(function() {
                    if (!parsing && !parsed) {
                        getExif(imagePath + "/" + files[index]);
                    }

                    if (parsed) {
                        parsed = false;

                        if (error) {
                            console.log(error);
                            error = false;
                        }

                        if (index === files.length) {
                            console.log("Done getting exif data\n\n");
                            clearInterval(interval);
                            fulfill(objects)
                        }
                    }
                });
            });
        };

        parseStringAsPromise()
            .then(function(images) {
                return downloadImagesAsPromise(images)
            })
            .then(function(files) {
                return parseExifsAsPromise(files);
            })
            .then(function(objects) {
                db.open(function(err, db) {
                    console.log("Dumping data to database\n");
                    let collection = db.collection("waldo");

                    for (var i in objects) {
                        collection.updateOne({filename: objects[i].filename}, objects[i], {upsert: true}, function(err, item) {
                            if (err) {
                                console.log(err);
                            }
                        });
                    }
                    console.log("Done!");

                     // Wait for a second
                     setTimeout(function() {

                         // Find the saved document
                         let testImageName = "001a59a1-4d67-4d03-a3b5-1bc5e321c581.bb899036-781a-467d-9995-5a236136565f.jpg";
                         collection.findOne({filename: testImageName}, function(err, item) {
                             if (err) {
                                 console.log(err);
                             }
                             else {
                                 console.dir(item);
                             }
                             db.close();
                         });
                     }, 1000);
                });
            })

            .catch(function(err) {
                console.log(err);
            })
    });
}).on("error", (e) => {
    console.log("Got error: ${e.message}");
});
