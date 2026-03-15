(function ($) {
    var state = {
        query: '',
        episodes: [],
        index: null,
        ready: false,
        timer: null,
        openEpisodeCode: ''
    };

    var $searchInput = $('#searchInput');
    var $resultsList = $('#resultsList');
    var $resultsToolbar = $('#resultsToolbar');
    var $resultsSummary = $('#resultsSummary');
    var $resultsHint = $('#resultsHint');

    function escapeHtml(value) {
        return $('<div>').text(value || '').html();
    }

    function normalizeToken(token) {
        token = (token || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (token.length <= 2) {
            return token;
        }
        if (token.endsWith('ies') && token.length > 4) {
            return token.slice(0, -3) + 'y';
        }
        if (token.endsWith('ing') && token.length > 5) {
            return token.slice(0, -3);
        }
        if (token.endsWith('ed') && token.length > 4) {
            return token.slice(0, -2);
        }
        if (token.endsWith('es') && token.length > 4) {
            return token.slice(0, -2);
        }
        if (token.endsWith('s') && token.length > 3) {
            return token.slice(0, -1);
        }
        return token;
    }

    function tokenize(text) {
        return (text.toLowerCase().match(/[a-z0-9']+/g) || [])
            .map(normalizeToken)
            .filter(function (token) {
                return token.length >= 3 && state.index.stopwords.indexOf(token) === -1;
            });
    }

    function expandTokens(tokens) {
        var expanded = tokens.slice();
        tokens.forEach(function (token) {
            (state.index.synonyms[token] || []).forEach(function (synonym) {
                expanded.push(normalizeToken(synonym));
            });
        });
        return Array.from(new Set(expanded)).slice(0, 14);
    }

    function buildQueryVector(tokens) {
        var counts = {};
        tokens.forEach(function (token) {
            counts[token] = (counts[token] || 0) + 1;
        });

        var weights = {};
        var norm = 0;
        Object.keys(counts).forEach(function (token) {
            var idf = state.index.idf[token];
            if (!idf) {
                return;
            }
            var weight = (1 + Math.log(counts[token])) * idf;
            weights[token] = weight;
            norm += weight * weight;
        });

        norm = Math.sqrt(norm) || 1;
        Object.keys(weights).forEach(function (token) {
            weights[token] = weights[token] / norm;
        });

        return weights;
    }

    function cosineScore(queryVector, sparseVector) {
        var score = 0;
        if (!queryVector || !sparseVector) {
            return score;
        }
        sparseVector.forEach(function (pair) {
            if (queryVector[pair[0]]) {
                score += queryVector[pair[0]] * pair[1];
            }
        });
        return score;
    }

    function publicCategories(episode) {
        return (episode.categories || []).filter(function (category) {
            return category.kind === 'archive';
        });
    }

    function normalizeSpace(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    function splitSentences(text) {
        return normalizeSpace(text)
            .split(/(?<=[.!?])\s+/)
            .map(function (sentence) { return $.trim(sentence); })
            .filter(Boolean);
    }

    function highlightText(text, tokens) {
        var html = escapeHtml(text);
        tokens.slice(0, 5).forEach(function (token) {
            if (!token) {
                return;
            }
            html = html.replace(new RegExp('(' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>');
        });
        return html;
    }

    function hitCount(text, tokens) {
        var lowered = normalizeSpace(text).toLowerCase();
        var count = 0;
        tokens.forEach(function (token) {
            if (lowered.indexOf(token) >= 0) {
                count += 1;
            }
        });
        return count;
    }

    function shortSummaryText(episode, tokens) {
        var candidateBlocks = []
            .concat(episode.overview ? [episode.overview] : [])
            .concat((episode.synopsis || '').split(/\n{2,}/))
            .map(normalizeSpace)
            .filter(Boolean);

        if (!candidateBlocks.length) {
            return 'Open the result to read the episode summary.';
        }

        var bestBlock = candidateBlocks[0];
        var bestScore = hitCount(bestBlock, tokens);

        candidateBlocks.forEach(function (block) {
            var score = hitCount(block, tokens);
            if (score > bestScore) {
                bestBlock = block;
                bestScore = score;
            }
        });

        var sentences = splitSentences(bestBlock);
        if (!sentences.length) {
            return bestBlock.slice(0, 220);
        }

        var summary = '';
        sentences.forEach(function (sentence) {
            if (!sentence) {
                return;
            }
            if (summary && (summary + ' ' + sentence).length > 230) {
                return;
            }
            if (!summary) {
                summary = sentence;
            } else if (summary.length < 150) {
                summary += ' ' + sentence;
            }
        });

        summary = normalizeSpace(summary || sentences[0]);
        if (summary.length > 230) {
            summary = summary.slice(0, 227).replace(/\s+\S*$/, '') + '...';
        }

        return summary;
    }

    function longSummaryParagraphs(episode) {
        var blocks = [];

        if (episode.overview) {
            blocks.push(normalizeSpace(episode.overview));
        }

        (episode.synopsis || '').split(/\n{2,}/).forEach(function (paragraph) {
            paragraph = normalizeSpace(paragraph);
            if (!paragraph) {
                return;
            }
            if (blocks.indexOf(paragraph) === -1) {
                blocks.push(paragraph);
            }
        });

        return blocks.slice(0, 3);
    }

    function shortSummaryHtml(episode, tokens) {
        return highlightText(shortSummaryText(episode, tokens), tokens);
    }

    function synopsisParagraphs(episode) {
        return longSummaryParagraphs(episode);
    }

    function noteLines(episode) {
        return (episode.notes || '')
            .split('\n')
            .map(function (line) { return $.trim(line); })
            .filter(Boolean)
            .slice(0, 2);
    }

    function updateUrl() {
        var params = new URLSearchParams();
        if (state.query) {
            params.set('q', state.query);
        }
        var next = 'index.html';
        if (params.toString()) {
            next += '?' + params.toString();
        }
        window.history.replaceState({}, '', next);
    }

    function renderResultsState(summary, hint) {
        $resultsToolbar.prop('hidden', false);
        $resultsSummary.text(summary);
        $resultsHint.text(hint);
        $resultsList.empty();
    }

    function resultMarkup(result, expandedTokens) {
        var episode = result.episode;
        var isOpen = state.openEpisodeCode === episode.episodeCode;
        var categories = publicCategories(episode);
        var synopsis = synopsisParagraphs(episode);
        var notes = noteLines(episode);
        var meta = [];

        if (episode.seasonNumber && episode.seasonEpisode) {
            meta.push('<span class="meta-chip">Season ' + episode.seasonNumber + ', Episode ' + episode.seasonEpisode + '</span>');
        }
        meta.push('<span class="meta-chip">' + escapeHtml(episode.airDateLabel) + '</span>');
        meta.push('<span class="meta-chip">Episode ' + escapeHtml(episode.episodeCode) + '</span>');

        return [
            '<article class="result-card', isOpen ? ' is-open' : '', '" data-episode-code="', escapeHtml(episode.episodeCode), '">',
            '<div class="result-shell">',
            '<div class="result-header">',
            '<div>',
            '<p class="result-code">Episode ', escapeHtml(episode.episodeCode), '</p>',
            '<h2 class="result-title">', escapeHtml(episode.title), '</h2>',
            '</div>',
            '</div>',
            '<div class="result-meta">', meta.join(''), '</div>',
            '<p class="result-summary">', shortSummaryHtml(episode, expandedTokens), '</p>',
            '<div class="result-footer">',
            categories.length ? '<div class="tag-list">' + categories.slice(0, 3).map(function (category) {
                return '<span class="tag">' + escapeHtml(category.name) + '</span>';
            }).join('') + '</div>' : '<span class="result-prompt">Tap to open summary and details.</span>',
            '<button class="result-action" type="button" data-result-toggle="', escapeHtml(episode.episodeCode), '" aria-expanded="', isOpen ? 'true' : 'false', '">', isOpen ? 'Show less' : 'Show more', '</button>',
            '</div>',
            '</div>',
            '<div class="detail-panel" ', isOpen ? '' : 'hidden', '>',
            '<div class="detail-grid">',
            '<div class="detail-block">',
            '<p class="detail-label">Summary</p>',
            synopsis.map(function (paragraph) {
                return '<p>' + escapeHtml(paragraph) + '</p>';
            }).join(''),
            notes.length ? '<div class="detail-block"><h3>Notes</h3><ul class="detail-list">' + notes.map(function (line) {
                return '<li>' + escapeHtml(line) + '</li>';
            }).join('') + '</ul></div>' : '',
            '</div>',
            '<aside class="detail-block">',
            '<h3>Episode Details</h3>',
            '<div class="detail-meta">',
            meta.join(''),
            '</div>',
            categories.length ? '<div class="detail-block"><p class="detail-label">Themes</p><div class="tag-list">' + categories.map(function (category) {
                return '<span class="tag">' + escapeHtml(category.name) + '</span>';
            }).join('') + '</div></div>' : '',
            '<div class="source-links">',
            '<a class="source-link" href="' + escapeHtml(episode.archiveUrl) + '" target="_blank" rel="noreferrer">Neighborhood Archive</a>',
            episode.tvdbUrl ? '<a class="source-link" href="' + escapeHtml(episode.tvdbUrl) + '" target="_blank" rel="noreferrer">TheTVDB</a>' : '',
            '</div>',
            '</aside>',
            '</div>',
            '</div>',
            '</article>'
        ].join('');
    }

    function runSearch() {
        state.query = $.trim($searchInput.val());
        updateUrl();

        if (!state.ready) {
            return;
        }

        if (!state.query) {
            state.openEpisodeCode = '';
            $resultsToolbar.prop('hidden', true);
            $resultsList.empty();
            return;
        }

        var originalTokens = tokenize(state.query);
        var expandedTokens = expandTokens(originalTokens);
        var queryVector = buildQueryVector(expandedTokens);
        var normalizedPhrase = originalTokens.join(' ');
        var hintSlugs = expandedTokens
            .map(function (token) { return state.index.queryCategoryHints[token]; })
            .filter(Boolean);

        var results = state.episodes
            .map(function (episode) {
                var lexical = 0;
                var categorySlugs = episode.categories.map(function (category) { return category.slug; });
                var titleText = episode.title.toLowerCase();

                originalTokens.forEach(function (token) {
                    if (episode.normalizedText.indexOf(token) >= 0) {
                        lexical += 4;
                    }
                    if (titleText.indexOf(token) >= 0) {
                        lexical += 3;
                    }
                });

                expandedTokens.forEach(function (token) {
                    if (episode.normalizedText.indexOf(token) >= 0) {
                        lexical += 1.25;
                    }
                });

                if (normalizedPhrase && episode.normalizedText.indexOf(normalizedPhrase) >= 0) {
                    lexical += 7;
                }

                if (lexical > 0) {
                    hintSlugs.forEach(function (slug) {
                        if (categorySlugs.indexOf(slug) >= 0) {
                            lexical += 2.5;
                        }
                    });
                }

                var semantic = cosineScore(queryVector, state.index.vectors[episode.id]);
                var score = lexical + (semantic * 14) + episode.sourceConfidence;

                return {
                    episode: episode,
                    score: score,
                    lexical: lexical
                };
            })
            .filter(function (result) {
                return result.lexical > 0;
            })
            .sort(function (left, right) {
                if (right.score !== left.score) {
                    return right.score - left.score;
                }
                return left.episode.episodeCode.localeCompare(right.episode.episodeCode);
            });

        if (results.length && results[0].score >= 12) {
            var minimumScore = Math.max(6, results[0].score * 0.5);
            results = results.filter(function (result) {
                return result.score >= minimumScore;
            });
        }

        results = results.slice(0, 18);

        if (!results.length) {
            state.openEpisodeCode = '';
            renderResultsState(
                'No close matches.',
                'Try a shorter search like haircut, dentist, making a sandwich, or mad feelings.'
            );
            return;
        }

        if (!results.some(function (result) { return result.episode.episodeCode === state.openEpisodeCode; })) {
            state.openEpisodeCode = '';
        }

        $resultsSummary.text(results.length === 1 ? '1 match' : results.length + ' matches');
        $resultsHint.text('Tap any result to open the short summary and episode details inline.');
        $resultsToolbar.prop('hidden', false);
        $resultsList.html(results.map(function (result) {
            return resultMarkup(result, expandedTokens);
        }).join(''));
    }

    function queueSearch() {
        window.clearTimeout(state.timer);
        state.timer = window.setTimeout(runSearch, 180);
    }

    function loadData() {
        return $.when(
            $.getJSON('data/episodes.json'),
            $.getJSON('data/search-index.json')
        ).done(function (episodesResponse, indexResponse) {
            state.episodes = episodesResponse[0];
            state.index = indexResponse[0];
            state.ready = true;

            var params = new URLSearchParams(window.location.search);
            state.query = params.get('q') || '';
            $searchInput.val(state.query);

            runSearch();
        }).fail(function () {
            renderResultsState('Could not load search data.', 'The episode files did not load.');
        });
    }

    $('#searchForm').on('submit', function (event) {
        event.preventDefault();
        runSearch();
    });

    $searchInput.on('input', queueSearch);

    $('#clearQueryButton').on('click', function () {
        state.query = '';
        state.openEpisodeCode = '';
        $searchInput.val('');
        runSearch();
        $searchInput.trigger('focus');
    });

    $(document).on('click', '[data-result-toggle]', function (event) {
        event.stopPropagation();
        var code = String($(this).attr('data-result-toggle') || '');
        state.openEpisodeCode = state.openEpisodeCode === code ? '' : code;
        runSearch();
    });

    $(document).on('click', '.result-card', function (event) {
        if ($(event.target).closest('a, button').length) {
            return;
        }
        if (window.getSelection && String(window.getSelection()).trim() !== '') {
            return;
        }
        var code = String($(this).attr('data-episode-code') || '');
        if (!code) {
            return;
        }
        state.openEpisodeCode = state.openEpisodeCode === code ? '' : code;
        runSearch();
    });

    loadData();
})(jQuery);
