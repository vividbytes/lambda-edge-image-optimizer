const querystring = require('querystring');
const http = require('http');
const https = require('https');
const fs = require('fs');
const child = require('child_process');

// headers that cloudfront does not allow in the http response
const blacklistedHeaders = [
    /^connection$/i,
    /^content-length$/i,
    /^expect$/i,
    /^keep-alive$/i,
    /^proxy-authenticate$/i,
    /^proxy-authorization$/i,
    /^proxy-connection$/i,
    /^trailer$/i,
    /^upgrade$/i,
    /^x-accel-buffering$/i,
    /^x-accel-charset$/i,
    /^x-accel-limit-rate$/i,
    /^x-accel-redirect$/i,
    /^X-Amz-Cf-.*/i,
    /^X-Amzn-.*/i,
    /^X-Cache.*/i,
    /^X-Edge-.*/i,
    /^X-Forwarded-Proto.*/i,
    /^X-Real-IP$/i
];

exports.handler = (event, context, callback) => {
    console.log(JSON.stringify(event, null, 2));
    const request = event.Records[0].cf.request;
    const origin = request.origin.custom;
    const protocol = origin.protocol;
    const tmpPath = '/tmp/sourceImage';
    const targetPath = '/tmp/targetImage';

    const getFile = origin.protocol === 'https' ?
        https.get :
        http.get;

    const options = querystring.parse(request.querystring);
    const maxSize = 2000;
    const width = Math.min(options.width || maxSize, maxSize);
    const height = Math.min(options.height || maxSize, maxSize);

    // make sure input values are numbers
    if (Number.isNaN(width) || Number.isNaN(height)) {
        console.log('Invalid input');
        context.succeed({
            status: '400',
            statusDescription: 'Invalid input'
        });
        return;
    }

    // dowload the file from the origin server
    getFile(`${origin.protocol}://${origin.domainName}${origin.path}${request.uri}`, (res) => {
        const statusCode = res.statusCode;
        console.log(res.headers);

        // grab headers from the origin request and reformat them
        // to match the lambda@edge return format
        const originHeaders = Object.keys(res.headers)
        // some headers we get back from the origin
        // must be filtered out because they are blacklisted by cloudfront
        .filter((header) => blacklistedHeaders.every((blheader) => !blheader.test(header)))
        .reduce((acc, header) => {
            acc[header.toLowerCase()] = [
                {
                    key: header,
                    value: res.headers[header]
                }
            ];
            return acc;
        }, {})

        if (statusCode === 200) {
            const writeStream = fs.createWriteStream(tmpPath);
            res
              .on('error', (e) => {
                  context.succeed({
                      status: '500',
                      statusDescription: 'Error downloading the image'
                  });
              })
              .pipe(writeStream)

            writeStream
            .on('finish', () => {
                console.log('image downloaded');

                try {
                    // invoke ImageMagick to resize the image
                    const stdout = child.execSync(
                        `convert ${tmpPath} -resize ${width}x${height}\\> -quality 80 ${targetPath}`
                    );
                } catch(e) {
                    console.log('ImageMagick error');
                    console.log(e.stderr.toString());
                    context.succeed({
                      status: '500',
                      statusDescription: 'Error resizing image'
                    });
                    return;
                }

                const image = fs.readFileSync(targetPath).toString('base64');

                context.succeed({
                    bodyEncoding: 'base64',
                    body: image,
                    headers: originHeaders,
                    status: '200',
                    statusDescription: 'OK'
                });
            })
            .on('error', (e) => {
                console.log(e);
                context.succeed({
                  status: '500',
                  statusDescription: 'Error writing the image to a file'
                });
            })
        } else {
            // grap the status code from the origin request
            // and return to the viewer
            console.log('statusCode: ', statusCode);
            context.succeed({
                status: statusCode.toString(),
                headers: originHeaders
            });
        }
    })
};
