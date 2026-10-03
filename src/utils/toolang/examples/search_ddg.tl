{
	"name": "web_search",
	"description": "Make a research via DuckDuckGo's API",
	"arguments": [
		{
			"type": "string",
			"name": "query",
			"description": "The search that you want to make",
			"disallow": [],
			"required": true
		}
	]
}¤

set var results to call(make_search, args.query)
return(Array.slice(results, 0, 5))

fn make_search with (query: string) do
set var req to http.get("https://api.duckduckgo.com/?q={1}&format={2}".format([query,"json"]))
--= (this is a comment) formats the text response to json, whereas .from will convert it to a string
return(json.to(req.response))
close
