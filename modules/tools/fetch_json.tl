{
	"name": "fetch_json",
	"description": "Fetch a URL and parse the response as JSON, returning status + parsed body",
	"arguments": [
		{
			"type": "string",
			"name": "url",
			"description": "The URL to fetch (must be http/https)",
			"disallow": []
		}
	]
}¤

set var res to http.get(args.url)
if res.status >= 400 then
throw("HTTP {1}: request failed".format([res.status]))
close
return({ status: res.status, body: json.to(res.response) })
