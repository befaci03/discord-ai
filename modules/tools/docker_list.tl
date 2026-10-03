{
	"name": "docker_list",
	"description": "List every Docker container on the host (name, image, status). Use this before docker_exec or docker_manage. Needs [docker].enabled = true",
	"arguments": []
}¤

set var res to docker.list()
if res.exitCode != 0 then
throw("docker_list failed: {1}".format([res.stderr]))
close
if res.stdout == "" then
return("no containers")
close
return(res.stdout)
