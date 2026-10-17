# Snippets

## Python

```python
def moving_average(xs, n):
    out = []
    for i in range(len(xs) - n + 1):
        out.append(sum(xs[i:i+n]) / n)

    return out
```

## YAML

```yaml
services:
  web:
    image: example/web:2
    ports:
      - "8080:80"
```

## Makefile

```
all:
	gcc -o app main.c

clean:
	rm -f app
```
